'use strict';

// The green lander ran 304 hourly times between 2026-10-31 and 2026-11-15
// and landed nothing. The receipts (atris/runs/autoland-tick-*.json) gave
// the reasons: attempt_cap 1897, merge_conflict 699, install_failed 496 (every
// one with an empty detail), protected_surface 16. Each test below rebuilds
// one of those shapes and holds the lander to the outcome it should reach.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { landStaleGreenBranches } = require('../lib/land-green');
const { isPullRequestLookup, pullRequestAnswer } = require('./helpers/branch-pull-requests');

const LIB = path.join(__dirname, '..', 'lib', 'land-green.js');
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

// Like this repo: a package-lock.json that names no dependency, a verify that
// passes while ok.txt says ok, a map, and a builder on the team.
function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-land-work-'));
  git(root, ['init', '-q', '-b', 'master']);
  git(root, ['config', 'user.name', 'Bench Author']);
  git(root, ['config', 'user.email', 'bench@example.com']);
  fs.writeFileSync(path.join(root, 'ok.txt'), 'ok\n');
  fs.writeFileSync(path.join(root, 'check.js'), "process.exit(require('fs').readFileSync('ok.txt','utf8').trim() === 'ok' ? 0 : 1);\n");
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '0.0.0', scripts: { test: 'node check.js' } }));
  fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({
    name: 'fixture', version: '0.0.0', lockfileVersion: 3, requires: true,
    packages: { '': { name: 'fixture', version: '0.0.0' } },
  }, null, 2));
  fs.mkdirSync(path.join(root, 'atris', 'team', 'builder'), { recursive: true });
  fs.writeFileSync(path.join(root, 'atris', 'team', 'builder', 'MEMBER.md'), '# builder\n');
  fs.writeFileSync(path.join(root, 'atris', 'MAP.md'), '# map\n\nfirst line\n');
  fs.mkdirSync(path.join(root, 'lib'));
  fs.writeFileSync(path.join(root, 'lib', 'known-commands.js'), "module.exports = ['a'];\n");
  commitAll(root, 'base', daysAgo(10));
  return root;
}

function branchWith(root, name, edit, when = daysAgo(3)) {
  git(root, ['checkout', '-q', '-b', name]);
  edit(root);
  const sha = commitAll(root, `${name} work`, when);
  git(root, ['checkout', '-q', 'master']);
  return sha;
}

function masterCommit(root, file, text) {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), text);
  return commitAll(root, `master edits ${file}`, new Date().toISOString());
}

const green = () => ({ status: 0, failing: [], command: 'node check.js', duration_ms: 1, timed_out: false, tail: '' });
const noTasks = () => { throw new Error('no job expected'); };

// A bare origin the branch and the pull request flow push to, with a fake gh.
function withOrigin(root) {
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-land-work-origin-'));
  git(bare, ['init', '-q', '--bare', '-b', 'master']);
  git(root, ['remote', 'add', 'origin', bare]);
  git(root, ['push', '-q', 'origin', 'master']);
  git(root, ['fetch', '-q', 'origin']);
  return bare;
}

function fakeGh() {
  const calls = [];
  const runGh = (args) => {
    calls.push(args);
    if (isPullRequestLookup(args)) return pullRequestAnswer(args);
    if (args[0] === 'pr' && args[1] === 'list') return { ok: true, stdout: '[]', stderr: '' };
    if (args[0] === 'pr' && args[1] === 'create') return { ok: true, stdout: 'https://github.com/acme/repo/pull/41', stderr: '' };
    if (args[0] === 'pr' && args[1] === 'merge') return { ok: true, stdout: '', stderr: '' };
    return { ok: false, stdout: '', stderr: 'unexpected gh call' };
  };
  return { calls, runGh };
}

test('under cron PATH a green branch in a zero-dependency repo lands: npm is found and nothing needs installing', () => {
  const root = makeRepo();
  try {
    const sha = branchWith(root, 'member/green', (dir) => fs.writeFileSync(path.join(dir, 'feature.txt'), 'shipped\n'));
    // The crontab line runs node by full path with PATH=/usr/bin:/bin.
    const script = `const r = require(${JSON.stringify(LIB)}).landStaleGreenBranches(${JSON.stringify(root)}, { push: false, openFlags: false });
      console.log(JSON.stringify(r.verdicts.map((v) => ({ branch: v.branch, action: v.action, reason: v.reason || null, detail: v.detail || null }))));`;
    const child = spawnSync(process.execPath, ['-e', script], {
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME, TMPDIR: os.tmpdir(), NODE_TEST_CONTEXT: process.env.NODE_TEST_CONTEXT || '' },
    });
    assert.equal(child.status, 0, child.stderr);
    const verdicts = JSON.parse(child.stdout.trim().split('\n').pop());
    assert.deepEqual(verdicts, [{ branch: 'member/green', action: 'landed', reason: null, detail: null }]);
    assert.equal(git(root, ['merge-base', '--is-ancestor', sha, 'master']), '');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('under cron PATH a map clash still commits through a repo hook that calls node', () => {
  const root = makeRepo();
  try {
    // Rehearsal on 2026-11-15: the map-only clash failed at the commit, since
    // the repo's pre-commit hook runs node and cron's PATH has none.
    fs.writeFileSync(path.join(root, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nnode -e "process.exit(0)" || exit 1\n', { mode: 0o755 });
    branchWith(root, 'member/map', (dir) => {
      fs.writeFileSync(path.join(dir, 'atris', 'MAP.md'), '# map\n\nbranch line\n');
      fs.writeFileSync(path.join(dir, 'feature.txt'), 'shipped\n');
    });
    masterCommit(root, 'atris/MAP.md', '# map\n\nmaster line\n');
    const script = `const r = require(${JSON.stringify(LIB)}).landStaleGreenBranches(${JSON.stringify(root)}, { push: false, openFlags: false });
      console.log(JSON.stringify(r.verdicts.map((v) => ({ action: v.action, reason: v.reason || null, detail: v.detail || null }))));`;
    const child = spawnSync(process.execPath, ['-e', script], {
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME, TMPDIR: os.tmpdir(), NODE_TEST_CONTEXT: process.env.NODE_TEST_CONTEXT || '' },
    });
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout.trim().split('\n').pop()), [{ action: 'landed', reason: null, detail: null }]);
    assert.equal(git(root, ['show', 'master:atris/MAP.md']), '# map\n\nmaster line');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('on a merge-queue remote a green branch goes through a pull request; master on origin is never pushed', () => {
  const root = makeRepo();
  const bare = withOrigin(root);
  try {
    branchWith(root, 'member/green', (dir) => fs.writeFileSync(path.join(dir, 'feature.txt'), 'shipped\n'));
    const originBefore = git(bare, ['rev-parse', 'master']);
    const gh = fakeGh();
    const recorded = [];
    const result = landStaleGreenBranches(root, {
      mergePath: 'pull_request',
      runVerifyFn: green,
      runGh: gh.runGh,
      recordQueued: (cwd, fields) => recorded.push(fields),
      fileConflictTask: noTasks,
      openFlags: false,
    });
    const verdict = result.verdicts[0];
    assert.equal(verdict.action, 'queued', JSON.stringify(verdict));
    assert.equal(verdict.pr, 41);
    assert.deepEqual(result.queued, ['member/green']);
    assert.equal(git(bare, ['rev-parse', 'master']), originBefore, 'master on origin did not move');
    assert.equal(git(bare, ['rev-parse', 'refs/heads/member/green']), verdict.sha, 'the checked commit is on the branch');
    const merge = gh.calls.find((c) => c[1] === 'merge');
    assert.deepEqual(merge, ['pr', 'merge', '41', '--auto', '--merge', '--match-head-commit', verdict.sha]);
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].number, 41);
    assert.equal(recorded[0].pushed, verdict.sha);
    assert.equal(recorded[0].branch, 'member/green');
    assert.equal(recorded[0].base, 'master');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(bare, { recursive: true, force: true });
  }
});

test('a branch that is only behind master is caught up in a scratch copy, checked, and queued with master in it', () => {
  const root = makeRepo();
  const bare = withOrigin(root);
  try {
    const tip = branchWith(root, 'member/behind', (dir) => fs.writeFileSync(path.join(dir, 'feature.txt'), 'shipped\n'));
    masterCommit(root, 'other.txt', 'master moved on\n');
    git(root, ['push', '-q', 'origin', 'master']);
    const masterTip = git(bare, ['rev-parse', 'master']);
    let checkedTree = null;
    const gh = fakeGh();
    const result = landStaleGreenBranches(root, {
      mergePath: 'pull_request',
      runVerifyFn: (cmd, dir) => { checkedTree = fs.existsSync(path.join(dir, 'other.txt')); return green(); },
      runGh: gh.runGh,
      recordQueued: () => {},
      fileConflictTask: noTasks,
      openFlags: false,
    });
    const verdict = result.verdicts[0];
    assert.equal(verdict.action, 'queued', JSON.stringify(verdict));
    assert.equal(checkedTree, true, 'the check ran on the caught-up tree');
    const pushed = git(bare, ['rev-parse', 'refs/heads/member/behind']);
    assert.equal(git(bare, ['merge-base', '--is-ancestor', masterTip, pushed]), '');
    assert.equal(git(bare, ['merge-base', '--is-ancestor', tip, pushed]), '');
    assert.equal(git(bare, ['rev-parse', 'master']), masterTip);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(bare, { recursive: true, force: true });
  }
});

test('a clash only in the map takes master\'s copy, refreshes, re-checks, and lands', () => {
  const root = makeRepo();
  try {
    // Receipt shape: merge_conflict, detail "atris/MAP.md".
    branchWith(root, 'codex/opus-learn-learning-team-product', (dir) => {
      fs.writeFileSync(path.join(dir, 'atris', 'MAP.md'), '# map\n\nbranch line\n');
      fs.writeFileSync(path.join(dir, 'feature.txt'), 'shipped\n');
    });
    masterCommit(root, 'atris/MAP.md', '# map\n\nmaster line\n');
    let verifies = 0;
    const result = landStaleGreenBranches(root, { push: false, openFlags: false, runVerifyFn: () => { verifies += 1; return green(); }, fileConflictTask: noTasks });
    const verdict = result.verdicts[0];
    assert.equal(verdict.action, 'landed', JSON.stringify(verdict));
    assert.deepEqual(verdict.regenerated, ['atris/MAP.md']);
    assert.equal(verifies, 1);
    assert.equal(git(root, ['show', 'master:atris/MAP.md']), '# map\n\nmaster line');
    assert.equal(git(root, ['show', 'master:feature.txt']), 'shipped');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a real clash goes back to a builder as a job naming the files, once per branch head', () => {
  const root = makeRepo();
  const db = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-land-work-db-')), 'tasks.db');
  const saved = process.env.ATRIS_TASKS_DB;
  process.env.ATRIS_TASKS_DB = db;
  try {
    // Receipt shape: merge_conflict, detail "lib/known-commands.js".
    branchWith(root, 'codex/claude-heavy-job-gate', (dir) => fs.writeFileSync(path.join(dir, 'lib', 'known-commands.js'), "module.exports = ['a', 'heavy'];\n"));
    masterCommit(root, 'lib/known-commands.js', "module.exports = ['a', 'town'];\n");
    const first = landStaleGreenBranches(root, { push: false, runCli: () => ({ status: 0, stdout: '' }) });
    const second = landStaleGreenBranches(root, { push: false, runCli: () => ({ status: 0, stdout: '' }) });
    const a = first.verdicts[0];
    const b = second.verdicts[0];
    assert.equal(a.reason, 'merge_conflict');
    assert.ok(a.hand_back && a.hand_back.task_id, JSON.stringify(a));
    assert.equal(a.hand_back.new, true);
    assert.equal(a.hand_back.member, 'builder');
    assert.deepEqual([b.reason, b.was, b.hand_back], ['waiting_for_change', 'merge_conflict', undefined], 'nothing moved: not checked, no second job');
    assert.deepEqual(first.handed_back, ['codex/claude-heavy-job-gate']);

    const taskDb = require('../lib/task-db');
    const row = taskDb.getTask(taskDb.open(db), a.hand_back.task_id);
    assert.equal(row.status, 'open');
    assert.match(row.title, /catch up codex\/claude-heavy-job-gate with master: it clashes in lib\/known-commands\.js/);
    assert.equal(row.metadata.assigned_to, 'builder');
    assert.deepEqual(row.metadata.conflict_files, ['lib/known-commands.js']);
  } finally {
    if (saved === undefined) delete process.env.ATRIS_TASKS_DB;
    else process.env.ATRIS_TASKS_DB = saved;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('four clashing branches at the head of the queue no longer hold the green ones behind them as attempt_cap', () => {
  const root = makeRepo();
  try {
    // Receipt shape on 2026-11-15: four merge_conflict verdicts, then
    // attempt_cap for every branch behind them, every hour.
    for (let i = 0; i < 4; i += 1) {
      branchWith(root, `sentinel-improve/clash-${i}`, (dir) => fs.writeFileSync(path.join(dir, 'lib', 'known-commands.js'), `module.exports = ['clash ${i}'];\n`), daysAgo(6 - i * 0.2));
    }
    masterCommit(root, 'lib/known-commands.js', "module.exports = ['master'];\n");
    branchWith(root, 'feat/hygiene-restore-cli', (dir) => fs.writeFileSync(path.join(dir, 'restore.txt'), 'x\n'), daysAgo(3));
    branchWith(root, 'feat/hygiene-sync-checkout', (dir) => fs.writeFileSync(path.join(dir, 'sync.txt'), 'x\n'), daysAgo(2.5));
    const tasks = [];
    const result = landStaleGreenBranches(root, {
      push: false, openFlags: false, handBack: true, localSuites: 2,
      runVerifyFn: green,
      fileConflictTask: (cwd, job) => { tasks.push(job); return { id: `T${tasks.length}`, inserted: true }; },
    });
    const reasons = Object.fromEntries(result.verdicts.map((v) => [v.branch, v.action === 'landed' ? 'landed' : v.reason]));
    assert.equal(Object.values(reasons).filter((r) => r === 'attempt_cap').length, 0, JSON.stringify(reasons));
    assert.equal(reasons['feat/hygiene-restore-cli'], 'landed');
    assert.equal(reasons['feat/hygiene-sync-checkout'], 'landed');
    assert.equal(tasks.length, 4);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a red branch waits while nothing moved, and is tried again once master moves', () => {
  const root = makeRepo();
  try {
    branchWith(root, 'member/red', (dir) => fs.writeFileSync(path.join(dir, 'ok.txt'), 'broken\n'));
    let verifies = 0;
    const red = () => { verifies += 1; return { status: 1, failing: ['ok check'], command: 'node check.js', duration_ms: 1, timed_out: false, tail: '' }; };
    const opts = { push: false, runVerifyFn: red, runCli: () => ({ status: 0, stdout: '' }), fileConflictTask: noTasks };
    const one = landStaleGreenBranches(root, opts);
    const two = landStaleGreenBranches(root, opts);
    assert.equal(one.verdicts[0].action, 'red');
    assert.equal(two.verdicts[0].reason, 'waiting_for_change', JSON.stringify(two.verdicts[0]));
    assert.equal(verifies, 1, 'the same two commits are not checked again');
    masterCommit(root, 'other.txt', 'moved\n');
    const three = landStaleGreenBranches(root, opts);
    assert.equal(three.verdicts[0].action, 'red');
    assert.equal(verifies, 2, 'master moved, so the count started over');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an install error gets a few tries on the same commits, then waits; a new branch commit starts over', () => {
  const root = makeRepo();
  try {
    branchWith(root, 'member/broken', (dir) => fs.writeFileSync(path.join(dir, 'package-lock.json'), 'not json\n'));
    const opts = { push: false, openFlags: false, fileConflictTask: noTasks };
    const reasons = [];
    for (let i = 0; i < 4; i += 1) reasons.push(landStaleGreenBranches(root, opts).verdicts[0].reason);
    assert.deepEqual(reasons, ['install_failed', 'install_failed', 'install_failed', 'waiting_for_change']);
    const detail = landStaleGreenBranches(root, opts).verdicts[0].detail;
    assert.match(detail, /tries again once the branch or master moves/);
    git(root, ['checkout', '-q', 'member/broken']);
    fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { '': {} } }));
    commitAll(root, 'fix the lockfile');
    git(root, ['checkout', '-q', 'master']);
    const fixed = landStaleGreenBranches(root, { ...opts, runVerifyFn: green });
    assert.equal(fixed.verdicts[0].action, 'landed', JSON.stringify(fixed.verdicts[0]));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Since 2026-11-15 one local suite per run is the default; the owner's
// green_landing_local_suites raises it. Raised to five, five land one at a
// time and a sixth waits.
test('five green branches land in one run when five local suites are allowed, one at a time; a sixth waits', () => {
  const root = makeRepo();
  try {
    for (let i = 0; i < 6; i += 1) {
      branchWith(root, `member/green-${i}`, (dir) => fs.writeFileSync(path.join(dir, `f${i}.txt`), `${i}\n`), daysAgo(6 - i * 0.3));
    }
    let running = 0;
    let most = 0;
    const result = landStaleGreenBranches(root, {
      push: false, openFlags: false, fileConflictTask: noTasks, localSuites: 5,
      runVerifyFn: () => { running += 1; most = Math.max(most, running); running -= 1; return green(); },
    });
    assert.equal(result.landed.length, 5, JSON.stringify(result.verdicts.map((v) => [v.branch, v.action, v.reason])));
    assert.equal(result.verdicts.filter((v) => v.reason === 'per_tick_limit').length, 1);
    assert.equal(most, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Review on 2026-11-15: the real check (the full suite) ran in a scratch copy
// inside the system temp folder, where the login write guard tests always
// fail, so every branch read red. The only real check in 305 receipts
// (autoland-tick-2026-11-12T16-01-24-827Z.json) was red that way.
test('the scratch copy sits outside the temp folder, so a check that refuses temp paths passes', () => {
  const root = makeRepo();
  const otherTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-land-work-tmpdir-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-land-work-home-'));
  try {
    // Like test/auth-test-write-guard.test.js: fails when the checkout sits
    // inside the temp folder the tests see.
    fs.writeFileSync(path.join(root, 'guard.js'), [
      "const fs = require('fs'); const os = require('os'); const path = require('path');",
      'const rel = path.relative(fs.realpathSync(os.tmpdir()), fs.realpathSync(process.cwd()));',
      "if (!rel.startsWith('..')) { console.log('✖ login write outside the temp dir is refused during tests (1ms)'); process.exit(1); }",
    ].join('\n'));
    commitAll(root, 'add the guard', daysAgo(9));
    branchWith(root, 'member/green', (dir) => fs.writeFileSync(path.join(dir, 'feature.txt'), 'shipped\n'));
    const script = `const r = require(${JSON.stringify(LIB)}).landStaleGreenBranches(${JSON.stringify(root)}, { push: false, openFlags: false, verifyCommand: 'node guard.js' });
      console.log(JSON.stringify(r.verdicts.map((v) => ({ action: v.action, reason: v.reason || null, failing: (v.verify && v.verify.failing) || [] }))));`;
    // The schedule's temp folder is not the folder the repo lives in, nor
    // the home folder the scratch copy goes under.
    const child = spawnSync(process.execPath, ['-e', script], {
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin', HOME: home, TMPDIR: otherTmp, NODE_TEST_CONTEXT: process.env.NODE_TEST_CONTEXT || '' },
    });
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout.trim().split('\n').pop()), [{ action: 'landed', reason: null, failing: [] }]);
    const scratchHome = path.join(home, '.atris', 'land-green-scratch');
    const folders = fs.readdirSync(scratchHome);
    assert.equal(folders.length, 1, 'one folder for this repo');
    assert.deepEqual(fs.readdirSync(path.join(scratchHome, folders[0])), [], 'the scratch copy is gone');
    assert.equal(fs.existsSync(path.join(root, '.git', 'atris-land-green-scratch')), false, 'nothing in the git folder');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(otherTmp, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// The same receipt failed 20 sandbox tests that fail on master too on this
// computer; hosted checks skip them. A test master already fails here is not
// the branch's fault, so on a merge-queue remote only new failures hold it.
test('on a merge-queue remote a test master already fails here does not hold a branch; a new failure does', () => {
  const root = makeRepo();
  const bare = withOrigin(root);
  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-land-work-log-')), 'checks.log');
  try {
    fs.writeFileSync(path.join(root, 'check2.js'), [
      "const fs = require('fs');",
      "fs.appendFileSync(process.env.CHECK_LOG, require('child_process').execSync('git rev-parse HEAD').toString());",
      "const names = fs.readFileSync('fails.txt', 'utf8').split('\\n').filter(Boolean);",
      "for (const n of names) console.log(`✖ ${n} (1ms)`);",
      'process.exit(names.length ? 1 : 0);',
    ].join('\n'));
    fs.writeFileSync(path.join(root, 'fails.txt'), 'one lap sandbox test\n');
    commitAll(root, 'master fails one machine-only test', daysAgo(9));
    git(root, ['push', '-q', 'origin', 'master']);
    branchWith(root, 'member/healthy', (dir) => fs.writeFileSync(path.join(dir, 'feature.txt'), 'shipped\n'), daysAgo(4));
    branchWith(root, 'member/broke-it', (dir) => fs.writeFileSync(path.join(dir, 'fails.txt'), 'one lap sandbox test\nits own break\n'), daysAgo(3));
    const gh = fakeGh();
    const result = landStaleGreenBranches(root, {
      mergePath: 'pull_request', verifyCommand: 'node check2.js', env: { ...process.env, CHECK_LOG: log }, localSuites: 2,
      runGh: gh.runGh, recordQueued: () => {}, readQueued: () => null, runCli: () => ({ status: 0, stdout: '' }), fileConflictTask: noTasks,
    });
    const by = Object.fromEntries(result.verdicts.map((v) => [v.branch, v]));
    assert.equal(by['member/healthy'].action, 'queued', JSON.stringify(by['member/healthy']));
    assert.deepEqual(by['member/healthy'].known_red, ['one lap sandbox test']);
    assert.equal(by['member/broke-it'].action, 'red', JSON.stringify(by['member/broke-it']));
    assert.deepEqual(by['member/broke-it'].verify.failing, ['its own break']);
    assert.match(by['member/broke-it'].flag ? 'flagged' : '', /flagged/);
    const masterSha = git(root, ['rev-parse', 'origin/master']);
    const runs = fs.readFileSync(log, 'utf8').trim().split('\n');
    assert.equal(runs.filter((sha) => sha === masterSha).length, 1, 'master is checked once per run');
    assert.equal(runs.length, 3);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(bare, { recursive: true, force: true });
    fs.rmSync(path.dirname(log), { recursive: true, force: true });
  }
});

test('with no hosted checks behind it, a test master fails still holds the branch', () => {
  const root = makeRepo();
  try {
    fs.writeFileSync(path.join(root, 'check2.js'), "console.log('✖ one lap sandbox test (1ms)'); process.exit(1);\n");
    commitAll(root, 'master fails one test', daysAgo(9));
    branchWith(root, 'member/healthy', (dir) => fs.writeFileSync(path.join(dir, 'feature.txt'), 'shipped\n'));
    const result = landStaleGreenBranches(root, { push: false, openFlags: false, verifyCommand: 'node check2.js', fileConflictTask: noTasks });
    assert.equal(result.verdicts[0].action, 'red', JSON.stringify(result.verdicts[0]));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Review on 2026-11-15: each run rebuilt the catch-up from the local branch,
// which never moves, so every push after the first was refused. One unread
// pull request list right after the push stuck the branch for good.
test('a caught-up branch builds on its own pushed catch-up, and once queued it waits for the sweep', () => {
  const root = makeRepo();
  const bare = withOrigin(root);
  try {
    branchWith(root, 'member/behind', (dir) => fs.writeFileSync(path.join(dir, 'feature.txt'), 'shipped\n'));
    git(root, ['push', '-q', 'origin', 'member/behind']);
    masterCommit(root, 'other.txt', 'master moved on\n');
    git(root, ['push', '-q', 'origin', 'master']);
    let lists = 0;
    let verifies = 0;
    const gh = fakeGh();
    const runGh = (args, ...rest) => {
      if (args[1] === 'list' && (lists += 1) === 1) return { ok: false, stdout: '', stderr: 'error connecting to api.github.com' };
      return gh.runGh(args, ...rest);
    };
    const opts = {
      mergePath: 'pull_request', runGh, openFlags: false, fileConflictTask: noTasks,
      runVerifyFn: () => { verifies += 1; return green(); },
    };
    const one = landStaleGreenBranches(root, opts).verdicts[0];
    assert.equal(one.reason, 'pull_request_unreadable', JSON.stringify(one));
    const two = landStaleGreenBranches(root, opts).verdicts[0];
    assert.equal(two.action, 'queued', JSON.stringify(two));
    assert.equal(two.sha, one.sha, 'the same catch-up commit, pushed again as a no-op');
    const queue = JSON.parse(fs.readFileSync(path.join(root, '.atris', 'state', 'autoland-queue.json'), 'utf8')).entries;
    assert.equal(queue['member/behind'].number, 41);
    assert.equal(queue['member/behind'].pushed, two.sha);
    masterCommit(root, 'more.txt', 'master moved again\n');
    git(root, ['push', '-q', 'origin', 'master']);
    const three = landStaleGreenBranches(root, opts).verdicts[0];
    assert.equal(three.action, 'skipped');
    assert.equal(three.reason, 'in_merge_queue', JSON.stringify(three));
    assert.equal(verifies, 2, 'a queued pull request costs no check while it waits');
    assert.equal(git(bare, ['rev-parse', 'refs/heads/member/behind']), two.sha);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(bare, { recursive: true, force: true });
  }
});

// Review on 2026-11-15: reusing a queued pull request replaced its entry with
// no jobs and a zero catch-up count, so its job was never closed or sent back.
test('reusing a member\'s queued pull request keeps its jobs and catch-up count', () => {
  const root = makeRepo();
  const bare = withOrigin(root);
  try {
    const first = branchWith(root, 'member/green', (dir) => fs.writeFileSync(path.join(dir, 'feature.txt'), 'shipped\n'));
    git(root, ['push', '-q', 'origin', 'member/green']);
    // The builder adds a fix after the member queued #7.
    git(root, ['checkout', '-q', 'member/green']);
    fs.writeFileSync(path.join(root, 'fix.txt'), 'fixed\n');
    commitAll(root, 'fix');
    git(root, ['checkout', '-q', 'master']);
    const file = path.join(root, '.atris', 'state', 'autoland-queue.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ schema: 'atris.autoland_queue.v1', entries: {
      'member/green': { branch: 'member/green', base: 'master', number: 7, pushed: first, source: 'member-autoland', task_ids: ['CLI-1'], requeues: 2 },
    } }));
    const calls = [];
    const runGh = (args) => {
      calls.push(args);
      if (isPullRequestLookup(args)) return pullRequestAnswer(args);
      if (args[1] === 'list') return { ok: true, stdout: JSON.stringify([{ number: 7, headRefName: 'member/green', baseRefName: 'master', isCrossRepository: false, url: 'https://github.com/acme/repo/pull/7' }]), stderr: '' };
      if (args[1] === 'merge') return { ok: true, stdout: '', stderr: '' };
      return { ok: false, stdout: '', stderr: 'unexpected gh call' };
    };
    const verdict = landStaleGreenBranches(root, { mergePath: 'pull_request', runGh, runVerifyFn: green, openFlags: false, fileConflictTask: noTasks }).verdicts[0];
    assert.equal(verdict.action, 'queued', JSON.stringify(verdict));
    assert.equal(verdict.pr, 7);
    const entry = JSON.parse(fs.readFileSync(file, 'utf8')).entries['member/green'];
    assert.deepEqual(entry.task_ids, ['CLI-1']);
    assert.equal(entry.source, 'member-autoland');
    assert.equal(entry.requeues, 2);
    assert.equal(entry.pushed, verdict.sha);
    assert.equal(entry.number, 7);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(bare, { recursive: true, force: true });
  }
});
