'use strict';

// The run at 2026-11-15T11:18Z (atris/runs/autoland-tick-2026-11-15T11-18-42-411Z.json)
// took 4,893 seconds and landed nothing. Four healthy branches ran the whole
// local suite in a scratch copy on a machine with a load average near 150,
// hit the 20 minute limit, and were marked red with reason verify_timed_out.
// The repo already has the real gate: a required merge queue with the hosted
// check "test". These tests hold the lander to letting that gate decide.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { landStaleGreenBranches, followQueuedLandings, summaryLine } = require('../lib/land-green');

const daysAgo = (n) => new Date(Date.now() - n * 24 * 3600 * 1000).toISOString();

function git(cwd, args, env = {}) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

function commitAll(cwd, message, when = daysAgo(3)) {
  git(cwd, ['add', '-A']);
  git(cwd, ['-c', 'user.name=Bench Author', '-c', 'user.email=bench@example.com', 'commit', '-q', '-m', message], {
    GIT_AUTHOR_DATE: when,
    GIT_COMMITTER_DATE: when,
  });
  return git(cwd, ['rev-parse', 'HEAD']);
}

// The lockfile names a package that does not exist, so an install that runs
// fails and shows up as install_failed instead of passing quietly.
function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-land-hosted-'));
  git(root, ['init', '-q', '-b', 'master']);
  git(root, ['config', 'user.name', 'Bench Author']);
  git(root, ['config', 'user.email', 'bench@example.com']);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '0.0.0', scripts: { test: 'node -e "process.exit(1)"' } }));
  fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({
    name: 'fixture', version: '0.0.0', lockfileVersion: 3, requires: true,
    packages: { '': { name: 'fixture', version: '0.0.0' }, 'node_modules/no-such-package-for-atris-tests': { version: '0.0.1' } },
  }, null, 2));
  fs.mkdirSync(path.join(root, 'atris', 'team', 'builder'), { recursive: true });
  fs.writeFileSync(path.join(root, 'atris', 'team', 'builder', 'MEMBER.md'), '# builder\n');
  commitAll(root, 'base', daysAgo(10));
  return root;
}

function withOrigin(root) {
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-land-hosted-origin-'));
  git(bare, ['init', '-q', '--bare', '-b', 'master']);
  git(root, ['remote', 'add', 'origin', bare]);
  git(root, ['push', '-q', 'origin', 'master']);
  git(root, ['fetch', '-q', 'origin']);
  return bare;
}

function branchWith(root, name, file, when = daysAgo(3)) {
  git(root, ['checkout', '-q', '-b', name]);
  fs.writeFileSync(path.join(root, file), `${name}\n`);
  const sha = commitAll(root, `${name} work`, when);
  git(root, ['checkout', '-q', 'master']);
  return sha;
}

// The branch rules GitHub returned for atrislabs/atris master on 2026-11-15.
const GUARDED_RULES = JSON.stringify([
  { type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'test' }] } },
  { type: 'merge_queue', parameters: { merge_method: 'MERGE', grouping_strategy: 'ALLGREEN' } },
]);

function fakeGh({ rules = GUARDED_RULES } = {}) {
  const calls = [];
  let next = 40;
  const runGh = (args) => {
    calls.push(args);
    if (args[0] === 'api' && /\/rules\/branches\//.test(args[1])) {
      return rules === null ? { ok: false, stdout: '', stderr: 'HTTP 404' } : { ok: true, stdout: rules, stderr: '' };
    }
    if (args[0] === 'api' && /\/protection/.test(args[1])) return { ok: false, stdout: '', stderr: 'HTTP 404: Branch not protected' };
    if (args[0] === 'pr' && args[1] === 'list') return { ok: true, stdout: '[]', stderr: '' };
    if (args[0] === 'pr' && args[1] === 'create') { next += 1; return { ok: true, stdout: `https://github.com/acme/repo/pull/${next}`, stderr: '' }; }
    if (args[0] === 'pr' && args[1] === 'merge') return { ok: true, stdout: '', stderr: '' };
    return { ok: false, stdout: '', stderr: 'unexpected gh call' };
  };
  return { calls, runGh };
}

const noTasks = () => { throw new Error('no job expected'); };
const noFlags = () => { throw new Error('no flag expected'); };

function cleanup(...dirs) {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
}

test('behind a required merge queue the local suite is never started: five branches are caught up and queued', () => {
  const root = makeRepo();
  const bare = withOrigin(root);
  try {
    const names = ['feat/one', 'feat/two', 'feat/three', 'feat/four', 'feat/five'];
    names.forEach((name, i) => branchWith(root, name, `f${i}.txt`, daysAgo(3 + i)));
    const gh = fakeGh();
    let suites = 0;
    const recorded = [];
    const started = Date.now();
    const result = landStaleGreenBranches(root, {
      mergePath: 'pull_request',
      runVerifyFn: () => { suites += 1; throw new Error('the local suite must not start on a guarded repo'); },
      runGh: gh.runGh,
      recordQueued: (cwd, fields) => recorded.push(fields),
      readQueued: () => null,
      runCli: noFlags,
      fileConflictTask: noTasks,
    });
    assert.equal(suites, 0, 'no local suite ran');
    assert.deepEqual(result.queued.sort(), [...names].sort(), JSON.stringify(result.verdicts));
    for (const v of result.verdicts) {
      assert.equal(v.local_check, 'hosted', JSON.stringify(v));
      assert.equal(v.verify, undefined, 'no local verify result');
    }
    assert.equal(result.local_check.local, false);
    assert.deepEqual(result.local_check.checks, ['test']);
    assert.equal(gh.calls.filter((c) => c[0] === 'api').length, 1, 'the guard is read once per run');
    const create = gh.calls.find((c) => c[1] === 'create');
    assert.match(create[create.indexOf('--body') + 1], /hosted checks/);
    assert.doesNotMatch(create[create.indexOf('--body') + 1], /checked with/);
    assert.equal(recorded.length, 5);
    assert.equal(git(bare, ['rev-parse', 'master']), git(root, ['rev-parse', 'master']), 'master on origin never pushed');
    assert.ok(Date.now() - started < 60 * 1000, 'five candidates take well under a minute');
  } finally {
    cleanup(root, bare);
  }
});

test('the owner can force the local check on behind a merge queue, or off on a repo with no required checks', () => {
  const root = makeRepo();
  const bare = withOrigin(root);
  try {
    fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ name: 'fixture', lockfileVersion: 3, packages: { '': {} } }));
    commitAll(root, 'empty lock', daysAgo(9));
    git(root, ['push', '-q', 'origin', 'master']);
    branchWith(root, 'feat/one', 'one.txt');
    const red = () => ({ status: 1, failing: ['a break'], failing_all: ['a break'], command: 'npm test', duration_ms: 1, timed_out: false, tail: '' });
    let suites = 0;
    const base = { mergePath: 'pull_request', recordQueued: () => {}, readQueued: () => null, openFlags: false, fileConflictTask: noTasks, stateFile: '' };
    // Forced on behind the merge queue: the local suite runs.
    const on = landStaleGreenBranches(root, { ...base, localCheck: true, runGh: fakeGh().runGh, runVerifyFn: () => { suites += 1; return red(); } });
    assert.equal(suites >= 1, true, JSON.stringify(on.verdicts[0]));
    assert.equal(on.verdicts[0].local_check, 'local');
    // No required checks and no override: the local check stays as today.
    suites = 0;
    const open = landStaleGreenBranches(root, { ...base, runGh: fakeGh({ rules: '[]' }).runGh, runVerifyFn: () => { suites += 1; return red(); } });
    assert.equal(open.verdicts[0].local_check, 'local', JSON.stringify(open.verdicts[0]));
    assert.equal(open.local_check.local, true);
    assert.equal(suites >= 1, true);
    suites = 0;
    // Rules that cannot be read keep the local check too.
    const unknown = landStaleGreenBranches(root, { ...base, dryRun: true, runGh: fakeGh({ rules: null }).runGh });
    assert.equal(unknown.verdicts[0].local_check, 'local');
    // Forced off: queued for whatever the hosted side runs.
    const off = landStaleGreenBranches(root, { ...base, localCheck: false, runGh: fakeGh({ rules: '[]' }).runGh, runVerifyFn: () => { suites += 1; return red(); } });
    assert.equal(off.verdicts[0].action, 'queued', JSON.stringify(off.verdicts[0]));
    assert.equal(suites, 0);
  } finally {
    cleanup(root, bare);
  }
});

test('a dry run on a guarded repo names each healthy branch as would-queue with no local check', () => {
  const root = makeRepo();
  const bare = withOrigin(root);
  try {
    branchWith(root, 'feat/one', 'one.txt');
    const result = landStaleGreenBranches(root, { mergePath: 'pull_request', dryRun: true, runGh: fakeGh().runGh, readQueued: () => null, runVerifyFn: noFlags });
    assert.equal(result.verdicts[0].would, 'queue', JSON.stringify(result.verdicts[0]));
    assert.equal(result.verdicts[0].local_check, 'hosted');
  } finally {
    cleanup(root, bare);
  }
});

test('a local check that runs out of time is could-not-tell: never red, no flag, one try per run, tried again later', () => {
  const root = makeRepo();
  try {
    // No remote, so the local check is the only gate. An empty lockfile
    // means nothing to install.
    fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ name: 'fixture', lockfileVersion: 3, packages: { '': {} } }));
    commitAll(root, 'empty lock', daysAgo(9));
    branchWith(root, 'feat/one', 'one.txt', daysAgo(5));
    branchWith(root, 'feat/two', 'two.txt', daysAgo(4));
    const stateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-land-hosted-state-')), 'state.json');
    let suites = 0;
    const slow = () => { suites += 1; return { status: null, timed_out: true, failing: ['half a test'], failing_all: ['half a test'], command: 'npm test', duration_ms: 1200000, tail: '' }; };
    const opts = { push: false, runVerifyFn: slow, runCli: noFlags, fileConflictTask: noTasks, stateFile };
    const first = landStaleGreenBranches(root, opts);
    assert.equal(suites, 1, 'one timed-out try per run');
    assert.deepEqual(first.red, []);
    const by = Object.fromEntries(first.verdicts.map((v) => [v.branch, v]));
    assert.equal(by['feat/one'].action, 'unknown', JSON.stringify(by['feat/one']));
    assert.equal(by['feat/one'].reason, 'verify_timed_out');
    assert.equal(by['feat/two'].action, 'unknown');
    assert.equal(by['feat/two'].reason, 'machine_busy');
    assert.match(summaryLine(first), /could not tell/);
    // The next run tries again instead of waiting for a new commit.
    const second = landStaleGreenBranches(root, opts);
    assert.equal(suites, 2);
    assert.notEqual(second.verdicts[0].reason, 'waiting_for_change', JSON.stringify(second.verdicts[0]));
    fs.rmSync(path.dirname(stateFile), { recursive: true, force: true });
  } finally {
    cleanup(root);
  }
});

test('an earlier verify_timed_out red is treated as not tried', () => {
  const root = makeRepo();
  try {
    fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ name: 'fixture', lockfileVersion: 3, packages: { '': {} } }));
    commitAll(root, 'empty lock', daysAgo(9));
    const head = branchWith(root, 'feat/hygiene-restore-cli', 'one.txt');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-land-hosted-state-'));
    const stateFile = path.join(dir, 'state.json');
    // The shape the 11:18Z run left behind.
    fs.writeFileSync(stateFile, JSON.stringify({ schema: 'atris.land_green.v1', branches: {
      'feat/hygiene-restore-cli': { head, base: git(root, ['rev-parse', 'master']), verify: 'npm test', action: 'red', reason: 'verify_timed_out', misses: 1, at: '2026-11-15T11:19:13.898Z' },
    } }));
    let suites = 0;
    const result = landStaleGreenBranches(root, {
      push: false, runCli: () => ({ status: 0, stdout: '' }), fileConflictTask: noTasks, stateFile,
      runVerifyFn: () => { suites += 1; return { status: 0, failing: [], command: 'npm test', duration_ms: 1, timed_out: false, tail: '' }; },
    });
    assert.equal(suites, 1, JSON.stringify(result.verdicts));
    assert.notEqual(result.verdicts[0].reason, 'waiting_for_change');
    fs.rmSync(dir, { recursive: true, force: true });
  } finally {
    cleanup(root);
  }
});

// What the next run reads back from GitHub for a pull request the lander queued.
function queueEntry(fields = {}) {
  return { branch: 'feat/one', base: 'master', number: 41, pushed: 'a'.repeat(40), source: 'land-green', task_ids: [], requeues: 0, reran: false, queued_at: new Date().toISOString(), ...fields };
}

function ghFor({ view, checks }) {
  const calls = [];
  const runGh = (args) => {
    calls.push(args);
    if (args[0] === 'pr' && args[1] === 'view') return { ok: true, stdout: JSON.stringify(view), stderr: '' };
    // gh exits nonzero when a check failed; the list is still on stdout.
    if (args[0] === 'pr' && args[1] === 'checks') return { ok: false, stdout: JSON.stringify(checks), stderr: '' };
    return { ok: false, stdout: '', stderr: 'unexpected gh call' };
  };
  return { calls, runGh };
}

test('a queued pull request that merged is done and its lander memory is cleared', () => {
  const memory = { 'feat/one': { head: 'x', reason: 'verify_timed_out' } };
  const gh = ghFor({ view: { state: 'MERGED', headRefOid: 'a'.repeat(40), mergedAt: new Date().toISOString() }, checks: [] });
  const out = followQueuedLandings('/nowhere', {
    runGh: gh.runGh, readEntries: () => ({ 'feat/one': queueEntry() }), markEntry: noTasks, fileChecksTask: noTasks, memory, runCli: noFlags,
  });
  assert.equal(out.results[0].state, 'merged');
  assert.equal(memory['feat/one'], undefined);
});

test('failed hosted checks go back to a builder as a job naming the checks, once, never to the owner', () => {
  const failing = [
    { name: 'unit (6/8)', bucket: 'fail' },
    { name: 'unit (2/8)', bucket: 'fail' },
    { name: 'unit (1/8)', bucket: 'pass' },
    { name: 'test', bucket: 'fail' },
  ];
  const view = { state: 'OPEN', headRefOid: 'a'.repeat(40) };
  // Not retried yet: the merge-line sweep runs the failed checks once first.
  const fresh = followQueuedLandings('/nowhere', {
    runGh: ghFor({ view, checks: failing }).runGh, readEntries: () => ({ 'feat/one': queueEntry() }),
    markEntry: noTasks, fileChecksTask: noTasks, memory: {}, runCli: noFlags,
  });
  assert.equal(fresh.results[0].state, 'waiting_for_retry', JSON.stringify(fresh.results[0]));
  // Retried once and still failing: a builder gets it.
  const jobs = [];
  const marks = [];
  const entry = queueEntry({ reran: 'a'.repeat(40) });
  const out = followQueuedLandings('/nowhere', {
    runGh: ghFor({ view, checks: failing }).runGh, readEntries: () => ({ 'feat/one': entry }),
    markEntry: (root, fields) => marks.push(fields),
    fileChecksTask: (root, job) => { jobs.push(job); return { id: 'JOB-1', inserted: true }; },
    memory: {}, runCli: noFlags,
  });
  assert.equal(out.results[0].state, 'handed_back', JSON.stringify(out.results[0]));
  assert.equal(jobs.length, 1);
  assert.deepEqual(jobs[0].checks, ['unit (6/8)', 'unit (2/8)', 'test']);
  assert.equal(jobs[0].number, 41);
  assert.equal(jobs[0].branch, 'feat/one');
  assert.equal(marks[0].checks_handed_back, 'a'.repeat(40));
  assert.equal(marks[0].checks_task, 'JOB-1');
  // The next run sees the mark and files nothing new.
  const again = followQueuedLandings('/nowhere', {
    runGh: ghFor({ view, checks: failing }).runGh, readEntries: () => ({ 'feat/one': { ...entry, ...marks[0] } }),
    markEntry: noTasks, fileChecksTask: noTasks, memory: {}, runCli: noFlags,
  });
  assert.equal(again.results[0].state, 'handed_back_earlier');
});

test('the follow-up reads only the lander\'s own entries and a dry run changes nothing', () => {
  const gh = ghFor({ view: { state: 'OPEN', headRefOid: 'a'.repeat(40) }, checks: [{ name: 'test', bucket: 'fail' }] });
  const out = followQueuedLandings('/nowhere', {
    runGh: gh.runGh, dryRun: true,
    readEntries: () => ({ 'feat/one': queueEntry({ reran: 'a'.repeat(40) }), 'member/x': queueEntry({ branch: 'member/x', source: 'member-autoland' }) }),
    markEntry: noTasks, fileChecksTask: noTasks, memory: {}, runCli: noFlags,
  });
  assert.equal(out.results.length, 1);
  assert.equal(out.results[0].state, 'would_hand_back');
});

test('a guarded run reads the queued pull requests before it lands anything', () => {
  const root = makeRepo();
  const bare = withOrigin(root);
  try {
    branchWith(root, 'feat/one', 'one.txt');
    const file = path.join(root, '.atris', 'state', 'autoland-queue.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ schema: 'atris.autoland_queue.v1', entries: { 'feat/old': queueEntry({ branch: 'feat/old', number: 9 }) } }));
    const gh = fakeGh();
    const runGh = (args, ...rest) => {
      if (args[0] === 'pr' && args[1] === 'view') return { ok: true, stdout: JSON.stringify({ state: 'MERGED', headRefOid: 'a'.repeat(40), mergedAt: new Date().toISOString() }), stderr: '' };
      return gh.runGh(args, ...rest);
    };
    const result = landStaleGreenBranches(root, { mergePath: 'pull_request', runGh, recordQueued: () => {}, readQueued: () => null, runCli: noFlags, fileConflictTask: noTasks, runVerifyFn: noFlags });
    assert.deepEqual(result.followed.map((r) => [r.branch, r.state]), [['feat/old', 'merged']]);
    assert.deepEqual(result.queued, ['feat/one']);
  } finally {
    cleanup(root, bare);
  }
});

// Reviewer finding 1. With the local check as the gate, a branch whose suite
// always runs out of time sat first in line forever: every run spent its one
// try on it and every branch behind it read "machine busy". The try is now
// remembered as a count only. Those branches go last next run, and after a
// few on the same commits a builder gets a job. Still never red, never a flag.
test('a branch whose local check always runs out of time cannot block the branches behind it', () => {
  const root = makeRepo();
  try {
    fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ name: 'fixture', lockfileVersion: 3, packages: { '': {} } }));
    commitAll(root, 'empty lock', daysAgo(9));
    const hangs = branchWith(root, 'feat/hangs', 'hangs.txt', daysAgo(5));
    branchWith(root, 'feat/healthy', 'healthy.txt', daysAgo(4));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-land-hosted-state-'));
    const stateFile = path.join(dir, 'state.json');
    const suites = [];
    const runVerifyFn = (command, cwd) => {
      const slow = fs.existsSync(path.join(cwd, 'hangs.txt'));
      suites.push(slow ? 'feat/hangs' : 'other');
      return slow
        ? { status: null, timed_out: true, failing: [], failing_all: [], command: 'npm test', duration_ms: 1200000, tail: '' }
        : { status: 0, timed_out: false, failing: [], command: 'npm test', duration_ms: 1, tail: '' };
    };
    const jobs = [];
    const opts = {
      push: false, runVerifyFn, runCli: noFlags, fileConflictTask: noTasks, stateFile,
      fileSlowCheckTask: (cwd, job) => { jobs.push(job); return { id: 'JOB-7', inserted: true }; },
    };
    const runs = [1, 2, 3, 4].map(() => landStaleGreenBranches(root, opts));
    const landed = runs.flatMap((r) => r.landed);
    assert.deepEqual(landed, ['feat/healthy'], JSON.stringify(runs.map((r) => r.verdicts)));
    assert.ok(runs[1].landed.includes('feat/healthy'), 'the healthy branch lands by the second run');
    for (const r of runs) {
      assert.deepEqual(r.red, [], 'never red');
      assert.ok(suites.length <= 8);
    }
    // Three timed-out tries on the same commits, then a builder has it.
    assert.equal(jobs.length, 1, JSON.stringify(runs.map((r) => r.verdicts)));
    assert.equal(jobs[0].branch, 'feat/hangs');
    assert.equal(jobs[0].head, hangs);
    assert.equal(jobs[0].tries, 3);
    const third = runs[2].verdicts.find((v) => v.branch === 'feat/hangs');
    assert.equal(third.action, 'unknown');
    assert.equal(third.hand_back.task_id, 'JOB-7');
    // The fourth run starts no suite on it: it waits for a new commit.
    const fourth = runs[3].verdicts.find((v) => v.branch === 'feat/hangs');
    assert.equal(fourth.action, 'skipped', JSON.stringify(fourth));
    assert.equal(fourth.reason, 'waiting_for_change');
    assert.equal(suites.filter((s) => s === 'feat/hangs').length, 3);
    const memory = JSON.parse(fs.readFileSync(stateFile, 'utf8')).branches;
    assert.equal(memory['feat/hangs'].action, 'unknown', JSON.stringify(memory));
    assert.equal(memory['feat/hangs'].untold, 3);
    fs.rmSync(dir, { recursive: true, force: true });
  } finally {
    cleanup(root);
  }
});

// Reviewer finding 3. The protected-lane and clash screens read the local
// branch, but on the pull request path the catch-up starts from origin's
// copy. Commits only on origin's copy went to the queue unscreened.
test('commits that sit only on origin\'s copy of a branch are screened for protected lanes before queueing', () => {
  const root = makeRepo();
  const bare = withOrigin(root);
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-land-hosted-clone-'));
  try {
    branchWith(root, 'feat/one', 'one.txt');
    git(root, ['push', '-q', 'origin', 'feat/one']);
    git(other, ['clone', '-q', bare, '.']);
    git(other, ['checkout', '-q', 'feat/one']);
    fs.mkdirSync(path.join(other, 'auth'), { recursive: true });
    fs.writeFileSync(path.join(other, 'auth', 'login.js'), 'module.exports = 1;\n');
    commitAll(other, 'touch the login lane', daysAgo(3));
    git(other, ['push', '-q', 'origin', 'feat/one']);
    const gh = fakeGh();
    const result = landStaleGreenBranches(root, {
      mergePath: 'pull_request', runGh: gh.runGh, recordQueued: () => {}, readQueued: () => null,
      runCli: noFlags, fileConflictTask: noTasks, runVerifyFn: noFlags, stateFile: null,
    });
    const v = result.verdicts.find((x) => x.branch === 'feat/one');
    assert.equal(v.action, 'skipped', JSON.stringify(v));
    assert.equal(v.reason, 'protected_surface');
    assert.equal(gh.calls.filter((c) => c[0] === 'pr' && c[1] === 'merge').length, 0, 'nothing queued');
  } finally {
    cleanup(root, bare, other);
  }
});

test('a builder\'s push to origin\'s copy after a hand-back is caught up and queued again, not left as in the merge queue', () => {
  const root = makeRepo();
  const bare = withOrigin(root);
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-land-hosted-clone-'));
  try {
    branchWith(root, 'feat/one', 'one.txt');
    git(root, ['push', '-q', 'origin', 'feat/one']);
    const queuedSha = git(root, ['rev-parse', 'feat/one']);
    git(other, ['clone', '-q', bare, '.']);
    git(other, ['checkout', '-q', 'feat/one']);
    fs.writeFileSync(path.join(other, 'fix.txt'), 'fix\n');
    commitAll(other, 'make the checks pass', daysAgo(3));
    git(other, ['push', '-q', 'origin', 'feat/one']);
    const gh = fakeGh();
    const result = landStaleGreenBranches(root, {
      mergePath: 'pull_request', runGh: gh.runGh, recordQueued: () => {},
      readQueued: () => ({ number: 41, pushed: queuedSha }),
      runCli: noFlags, fileConflictTask: noTasks, runVerifyFn: noFlags, stateFile: null,
    });
    const v = result.verdicts.find((x) => x.branch === 'feat/one');
    assert.equal(v.action, 'queued', JSON.stringify(v));
  } finally {
    cleanup(root, bare, other);
  }
});

test('handing back failed hosted checks switches auto-merge off so a later push waits for the lander', () => {
  const failing = [{ name: 'test', bucket: 'fail' }];
  const gh = ghFor({ view: { state: 'OPEN', headRefOid: 'a'.repeat(40) }, checks: failing });
  const out = followQueuedLandings('/nowhere', {
    runGh: gh.runGh, readEntries: () => ({ 'feat/one': queueEntry({ reran: 'a'.repeat(40) }) }),
    markEntry: () => {}, fileChecksTask: () => ({ id: 'JOB-1', inserted: true }), memory: {}, runCli: noFlags,
  });
  assert.equal(out.results[0].state, 'handed_back');
  const disable = gh.calls.find((c) => c[0] === 'pr' && c[1] === 'merge');
  assert.ok(disable, JSON.stringify(gh.calls));
  assert.deepEqual(disable.slice(0, 4), ['pr', 'merge', '41', '--disable-auto']);
  // After the builder pushes, the follow-up says the lander takes it from here.
  const changed = followQueuedLandings('/nowhere', {
    runGh: ghFor({ view: { state: 'OPEN', headRefOid: 'b'.repeat(40) }, checks: [] }).runGh,
    readEntries: () => ({ 'feat/one': queueEntry({ reran: 'a'.repeat(40), checks_handed_back: 'a'.repeat(40), checks_task: 'JOB-1' }) }),
    markEntry: noTasks, fileChecksTask: noTasks, memory: {}, runCli: noFlags,
  });
  assert.equal(changed.results[0].state, 'changed');
  assert.match(changed.results[0].line, /lander/);
});

// Reviewer finding 2. "atris land --auto" never read green_landing_local_check
// and dropped an explicit --verify on a guarded repo.
function cliFixture(policy) {
  const root = makeRepo();
  const holder = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-land-hosted-gh-'));
  const bare = path.join(holder, 'github.com', 'acme', 'repo.git');
  fs.mkdirSync(bare, { recursive: true });
  git(bare, ['init', '-q', '--bare', '-b', 'master']);
  git(root, ['remote', 'add', 'origin', bare]);
  git(root, ['push', '-q', 'origin', 'master']);
  git(root, ['fetch', '-q', 'origin']);
  branchWith(root, 'feat/one', 'one.txt');
  if (policy) {
    fs.mkdirSync(path.join(root, '.atris', 'policy'), { recursive: true });
    fs.writeFileSync(path.join(root, '.atris', 'policy', 'autoland.json'), JSON.stringify(policy));
  }
  const bin = path.join(holder, 'bin');
  fs.mkdirSync(bin);
  const log = path.join(holder, 'gh-calls.log');
  const rules = path.join(holder, 'rules.json');
  fs.writeFileSync(rules, GUARDED_RULES);
  fs.writeFileSync(path.join(bin, 'gh'), [
    '#!/bin/sh',
    `echo "$*" >> "${log}"`,
    'case "$1 $2" in',
    `  "api repos/{owner}/{repo}/rules/branches/"*) cat "${rules}" ;;`,
    '  "pr list"*) echo "[]" ;;',
    '  *) echo "unexpected" >&2; exit 1 ;;',
    'esac',
    '',
  ].join('\n'));
  fs.chmodSync(path.join(bin, 'gh'), 0o755);
  return { root, holder, bin, log };
}

function runLandAuto(fx, extra = []) {
  const home = path.join(fx.holder, 'home');
  fs.mkdirSync(home, { recursive: true });
  const cli = path.join(__dirname, '..', 'bin', 'atris.js');
  const run = spawnSync(process.execPath, [cli, 'land', '--auto', '--dry-run', '--json', ...extra], {
    cwd: fx.root, encoding: 'utf8', timeout: 60000,
    env: { ...process.env, HOME: home, PATH: `${fx.bin}${path.delimiter}${process.env.PATH}`, ATRIS_NO_BOOT: '1' },
  });
  const text = String(run.stdout || '');
  const start = text.indexOf('{');
  assert.ok(start >= 0, `no json: ${text} ${run.stderr}`);
  return JSON.parse(text.slice(start));
}

test('atris land --auto honours the owner\'s green_landing_local_check switch on a guarded repo', () => {
  const fx = cliFixture({ enabled: true, green_landing_local_check: true });
  try {
    const result = runLandAuto(fx);
    assert.equal(result.local_check.local, true, JSON.stringify(result.local_check));
    assert.equal(result.local_check.mode, 'on');
    const v = result.verdicts.find((x) => x.branch === 'feat/one');
    assert.equal(v.local_check, 'local', JSON.stringify(v));
  } finally {
    cleanup(fx.root, fx.holder);
  }
});

test('atris land --auto with an explicit --verify runs that check locally even on a guarded repo', () => {
  const fx = cliFixture(null);
  try {
    const result = runLandAuto(fx, ['--verify', 'node -e 0']);
    assert.equal(result.local_check.local, true, JSON.stringify(result.local_check));
    const v = result.verdicts.find((x) => x.branch === 'feat/one');
    assert.equal(v.local_check, 'local', JSON.stringify(v));
  } finally {
    cleanup(fx.root, fx.holder);
  }
});

test('atris land --auto with no switch still lets the hosted checks decide on a guarded repo', () => {
  const fx = cliFixture(null);
  try {
    const result = runLandAuto(fx);
    assert.equal(result.local_check.local, false, JSON.stringify(result.local_check));
    const v = result.verdicts.find((x) => x.branch === 'feat/one');
    assert.equal(v.local_check, 'hosted', JSON.stringify(v));
  } finally {
    cleanup(fx.root, fx.holder);
  }
});
