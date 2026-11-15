'use strict';

// The runs on 2026-11-15 between 20:29 and 21:14 wasted whole runs. Another
// project's check held the machine lock for a few minutes, so all fifteen
// branches said "tries again next run". The load was high for a minute after
// a check ended, so thirteen rows said "the machine is busy". And on one
// project the check it just ran made the load that refused master's own
// check, so a failed branch could never be compared and stayed "could not
// tell" forever. The guard now waits for the machine, bounded, instead of
// giving up at once. The clock, the sleep, the load and the lock are all
// injected here: no test sleeps for real.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { landStaleGreenBranches, summaryLine, machineWaitSetting } = require('../lib/land-green');
const { isPullRequestLookup, pullRequestAnswer, pr } = require('./helpers/branch-pull-requests');

const daysAgo = (n) => new Date(Date.now() - n * 24 * 3600 * 1000).toISOString();
const MINUTE = 60 * 1000;

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

// No remote and an empty lockfile: the local check is the only gate and
// nothing is installed.
function localRepo(names) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-land-wait-'));
  git(root, ['init', '-q', '-b', 'master']);
  git(root, ['config', 'user.name', 'Bench Author']);
  git(root, ['config', 'user.email', 'bench@example.com']);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '0.0.0' }));
  fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ name: 'fixture', lockfileVersion: 3, packages: { '': {} } }));
  commitAll(root, 'base', daysAgo(10));
  names.forEach((name, i) => {
    git(root, ['checkout', '-q', '-b', name]);
    fs.writeFileSync(path.join(root, `f${i}.txt`), `${name}\n`);
    commitAll(root, `${name} work`, daysAgo(3 + i));
    git(root, ['checkout', '-q', 'master']);
  });
  return root;
}

function cleanup(...dirs) {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
}

const GREEN = { status: 0, timed_out: false, failing: [], failing_all: [], command: 'npm test', duration_ms: 1, tail: '' };
const noTasks = () => { throw new Error('no job expected'); };
const noFlags = () => { throw new Error('no flag expected'); };

// A fake machine: its own clock, a sleep that only moves that clock, a load
// the test sets, and a lock file in a throwaway folder.
function fakeMachine({ load = 0.5, cores = 8, onSleep = () => {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-land-wait-machine-'));
  const m = {
    dir,
    lockFile: path.join(dir, 'locks', 'local-suite.lock'),
    load,
    now: Date.now(),
    sleeps: [],
  };
  m.options = (extra = {}) => ({
    lockFile: m.lockFile,
    loadAvg: () => [m.load, m.load, m.load],
    cpuCount: () => cores,
    clock: () => m.now,
    sleep: (ms) => { m.sleeps.push(ms); m.now += ms; onSleep(m); },
    ...extra,
  });
  m.slept = () => m.sleeps.reduce((a, b) => a + b, 0);
  return m;
}

function holdLock(lockFile, ageMs = MINUTE, repo = 'another-project') {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  fs.writeFileSync(lockFile, JSON.stringify({ pid: 999999, host: os.hostname(), token: 'other', repo, at: new Date(Date.now() - ageMs).toISOString() }));
}

function run(root, m, extra = {}) {
  return landStaleGreenBranches(root, {
    push: false, stateFile: null, runCli: noFlags, fileConflictTask: noTasks, fileSlowCheckTask: noTasks,
    runVerifyFn: () => GREEN,
    machine: m.options(),
    ...extra,
  });
}

test('another local check holds the machine: the run waits for it to end, then runs its own', () => {
  const root = localRepo(['feat/one']);
  const m = fakeMachine({ onSleep: (mm) => { if (mm.sleeps.length === 3) fs.rmSync(mm.lockFile, { force: true }); } });
  try {
    holdLock(m.lockFile);
    let suites = 0;
    const result = run(root, m, { runVerifyFn: () => { suites += 1; return GREEN; } });
    assert.equal(suites, 1, JSON.stringify(result.verdicts));
    assert.deepEqual(result.landed, ['feat/one']);
    const v = result.verdicts[0];
    assert.equal(v.waited_ms, 3 * 30 * 1000, JSON.stringify(v));
    assert.match(v.waited, /^waited 2 minutes for another local check to finish$/);
    assert.equal(result.machine_wait.waited_ms, 90 * 1000);
    assert.match(summaryLine(result), /waited 2 minutes in all for a busy machine/);
    assert.equal(fs.existsSync(m.lockFile), false, 'its own lock is released after the suite');
  } finally {
    cleanup(root, m.dir);
  }
});

test('the machine is busy: the run waits for the load to settle, then runs', () => {
  const root = localRepo(['feat/one']);
  const m = fakeMachine({ load: 34.3, onSleep: (mm) => { if (mm.sleeps.length === 2) mm.load = 4; } });
  try {
    let loadAtStart = null;
    const result = run(root, m, { runVerifyFn: () => { loadAtStart = m.load; return GREEN; } });
    assert.deepEqual(result.landed, ['feat/one'], JSON.stringify(result.verdicts));
    assert.equal(loadAtStart, 4, 'the suite started only once the load was under the limit');
    assert.equal(result.verdicts[0].waited_ms, MINUTE);
    assert.match(result.verdicts[0].waited, /^waited 1 minute for the load to settle$/);
  } finally {
    cleanup(root, m.dir);
  }
});

test('a machine that stays busy: the run gives up after one wait and says how long it waited', () => {
  const root = localRepo(['feat/one']);
  const m = fakeMachine({ load: 34.3 });
  try {
    let suites = 0;
    const result = run(root, m, { runVerifyFn: () => { suites += 1; return GREEN; } });
    assert.equal(suites, 0);
    const v = result.verdicts[0];
    assert.equal(v.action, 'unknown', JSON.stringify(v));
    assert.equal(v.reason, 'machine_busy');
    assert.equal(v.detail, 'the machine is busy (load 34.3 on 8 cores); waited 10 minutes, no local check started; tries again next run');
    assert.match(v.waited, /^waited 10 minutes for the load to settle, then gave up$/);
    assert.equal(m.slept(), 10 * MINUTE, 'one wait is at most ten minutes');
    assert.deepEqual(result.red, []);
    assert.equal(fs.existsSync(m.lockFile), false, 'no lock taken');
  } finally {
    cleanup(root, m.dir);
  }
});

test('the wait never starts a suite while the load is over the limit, even right after the lock is taken', () => {
  const root = localRepo(['feat/one']);
  // The load reads quiet for the first look and the lock, then high once the
  // lock is held, then settles: the suite must wait for that.
  let reads = 0;
  const m = fakeMachine();
  try {
    let loadAtStart = null;
    const result = run(root, m, {
      machine: m.options({ loadAvg: () => { reads += 1; return [reads === 3 ? 40 : (m.sleeps.length ? 1 : 0.5)]; } }),
      runVerifyFn: () => { loadAtStart = reads; return GREEN; },
    });
    assert.deepEqual(result.landed, ['feat/one'], JSON.stringify(result.verdicts));
    assert.ok(m.sleeps.length >= 1, 'it waited once the high load showed up');
    assert.ok(loadAtStart > 3);
  } finally {
    cleanup(root, m.dir);
  }
});

test('the per run cap holds: waits stop once the run has waited its limit, and later rows say so', () => {
  const names = ['feat/one', 'feat/two', 'feat/three', 'feat/four'];
  const root = localRepo(names);
  const m = fakeMachine({ load: 50 });
  try {
    let suites = 0;
    const result = run(root, m, { localSuites: 4, runVerifyFn: () => { suites += 1; return GREEN; } });
    assert.equal(suites, 0);
    // Fifteen minutes a run, three of them kept back for master's own check:
    // the branches may wait twelve in all.
    assert.equal(m.slept(), 12 * MINUTE, JSON.stringify(m.sleeps));
    const by = Object.fromEntries(result.verdicts.map((v) => [v.branch, v]));
    const first = by[result.candidates[0]];
    const second = by[result.candidates[1]];
    const third = by[result.candidates[2]];
    assert.match(first.detail, /waited 10 minutes, no local check started/);
    assert.match(second.detail, /waited 2 minutes, no local check started/);
    assert.match(third.detail, /the 15 minutes this run may wait are used up, no local check started; tries again next run$/);
    assert.equal(third.waited_ms, undefined);
    assert.equal(result.machine_wait.waited_ms, 12 * MINUTE);
    assert.equal(result.machine_wait.limit_ms, 15 * MINUTE);
    assert.match(summaryLine(result), /waited 12 minutes in all for a busy machine/);
  } finally {
    cleanup(root, m.dir);
  }
});

test('the owner\'s green_landing_wait_minutes sets the run\'s limit; 0 gives up at once as before', () => {
  assert.equal(machineWaitSetting(null), 15);
  assert.equal(machineWaitSetting({}), 15);
  assert.equal(machineWaitSetting({ green_landing_wait_minutes: 40 }), 40);
  assert.equal(machineWaitSetting({ green_landing_wait_minutes: 0 }), 0);
  assert.equal(machineWaitSetting({ green_landing_wait_minutes: -3 }), 15);
  assert.equal(machineWaitSetting({ green_landing_wait_minutes: 'soon' }), 15);
  const root = localRepo(['feat/one']);
  const m = fakeMachine({ load: 50 });
  try {
    const off = run(root, m, { waitMinutes: 0 });
    assert.equal(m.sleeps.length, 0);
    assert.equal(off.verdicts[0].detail, 'the machine is busy (load 50.0 on 8 cores); no local check started; tries again next run');
    const short = run(root, m, { waitMinutes: 4 });
    // Four minutes a run keeps three for master's own check, so one is left.
    assert.equal(m.slept(), 1 * MINUTE);
    assert.match(short.verdicts[0].detail, /waited 1 minute, no local check started/);
  } finally {
    cleanup(root, m.dir);
  }
});

test('a dry run never waits, even with the lock held and the load high', () => {
  const root = localRepo(['feat/one']);
  const m = fakeMachine({ load: 50 });
  try {
    holdLock(m.lockFile);
    const result = run(root, m, {
      dryRun: true,
      machine: m.options({ sleep: () => { throw new Error('a dry run must not wait'); } }),
      runVerifyFn: () => { throw new Error('a dry run starts no suite'); },
    });
    assert.equal(result.verdicts[0].reason, 'dry_run', JSON.stringify(result.verdicts[0]));
    assert.equal(result.machine_wait.waited_ms, 0);
  } finally {
    cleanup(root, m.dir);
  }
});

test('two runs never hold the lock together: the second waits while the first runs, then gives up without a suite', () => {
  const first = localRepo(['feat/one']);
  const second = localRepo(['feat/two']);
  const m = fakeMachine();
  try {
    let inner = null;
    let innerSuites = 0;
    let holder = null;
    const outer = run(first, m, {
      runVerifyFn: () => {
        holder = JSON.parse(fs.readFileSync(m.lockFile, 'utf8'));
        // A second project's run starts while this suite holds the machine.
        inner = run(second, m, { runVerifyFn: () => { innerSuites += 1; return GREEN; } });
        assert.equal(JSON.parse(fs.readFileSync(m.lockFile, 'utf8')).token, holder.token, 'the second run never took the lock');
        return GREEN;
      },
    });
    assert.deepEqual(outer.landed, ['feat/one'], JSON.stringify(outer.verdicts));
    assert.equal(innerSuites, 0);
    const v = inner.verdicts[0];
    assert.equal(v.reason, 'machine_busy', JSON.stringify(v));
    assert.match(v.detail, /^another local check holds the machine \(atris-land-wait-\w+\); waited 10 minutes, no local check started/);
    assert.equal(fs.existsSync(m.lockFile), false);
    // Once the first is done, the second runs.
    const again = run(second, m, { runVerifyFn: () => { innerSuites += 1; return GREEN; } });
    assert.equal(innerSuites, 1);
    assert.deepEqual(again.landed, ['feat/two']);
  } finally {
    cleanup(first, second, m.dir);
  }
});

// The master comparison. A GitHub repo with no hosted checks: the branch is
// checked here, and a failure is compared with master's own check.
function githubRepo({ older = '' } = {}) {
  const root = localRepo(older ? [older] : []);
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-land-wait-origin-'));
  git(bare, ['init', '-q', '--bare', '-b', 'master']);
  git(root, ['remote', 'add', 'origin', bare]);
  git(root, ['push', '-q', 'origin', 'master']);
  git(root, ['fetch', '-q', 'origin']);
  git(root, ['checkout', '-q', '-b', 'member/green']);
  fs.writeFileSync(path.join(root, 'feature.txt'), 'shipped\n');
  commitAll(root, 'member/green work', daysAgo(2));
  git(root, ['checkout', '-q', 'master']);
  return { root, bare };
}

function fakeGithub(bare) {
  const state = { merged: '' };
  const runGh = (args) => {
    if (isPullRequestLookup(args)) {
      return pullRequestAnswer(args, (branch) => (state.merged && branch === 'member/green'
        ? [pr({ number: 41, state: 'MERGED', headRefName: branch, headRefOid: state.merged })] : []));
    }
    if (args[0] === 'api' && /\/rules\/branches\//.test(args[1])) return { ok: true, stdout: '[]', stderr: '' };
    if (args[0] === 'api' && /\/protection/.test(args[1])) return { ok: false, stdout: '', stderr: 'HTTP 404: Branch not protected' };
    if (args[0] === 'pr' && args[1] === 'list') return { ok: true, stdout: '[]', stderr: '' };
    if (args[0] === 'pr' && args[1] === 'create') return { ok: true, stdout: 'https://github.com/acme/repo/pull/41', stderr: '' };
    if (args[0] === 'pr' && args[1] === 'merge') {
      const sha = args[args.indexOf('--match-head-commit') + 1];
      git(bare, ['update-ref', 'refs/heads/master', sha]);
      state.merged = sha;
      return { ok: true, stdout: '', stderr: '' };
    }
    if (args[0] === 'pr' && args[1] === 'view') {
      return { ok: true, stdout: JSON.stringify(state.merged ? { state: 'MERGED', headRefOid: state.merged, mergeCommit: { oid: state.merged } } : { state: 'OPEN', headRefOid: '', mergeCommit: null }), stderr: '' };
    }
    return { ok: false, stdout: '', stderr: 'unexpected gh call' };
  };
  return { runGh, state };
}

const SAME_FAILURE = { status: 1, timed_out: false, failing: ['app/old.test.tsx > flaky on master'], failing_all: ['app/old.test.tsx > flaky on master'], signs: ['FAIL app/old.test.tsx'], command: 'npm test', duration_ms: 155000, tail: '', error_line: 'FAIL app/old.test.tsx' };

function compareRun(root, gh, m, extra = {}) {
  return landStaleGreenBranches(root, {
    mergePath: 'pull_request', runGh: gh.runGh, recordQueued: () => {}, readQueued: () => null, readEntries: () => ({}),
    fileConflictTask: noTasks, closeCatchUpJobs: () => [], openFlags: false, handBack: true, stateFile: null,
    mergeRetry: { tries: 1, waitMs: 0, sleep: () => {} },
    machine: m.options(),
    ...extra,
  });
}

test('the master comparison after a failed branch check waits for the load that check made, then runs', () => {
  const { root, bare } = githubRepo();
  // The branch's own check leaves the load at about three times the cores
  // (the 20:44 web run: 320 percent CPU for 155 seconds); a minute later it
  // has settled.
  const m = fakeMachine({ onSleep: (mm) => { if (mm.sleeps.length === 2) mm.load = 3; } });
  try {
    const gh = fakeGithub(bare);
    const cwds = [];
    const result = compareRun(root, gh, m, {
      runVerifyFn: (command, cwd) => { cwds.push(cwd); m.load = 31; return SAME_FAILURE; },
    });
    const v = result.verdicts.find((x) => x.branch === 'member/green');
    assert.equal(cwds.length, 2, `the branch check and master's own check both ran: ${JSON.stringify(v)}`);
    assert.notEqual(v.reason, 'machine_busy', JSON.stringify(v));
    assert.deepEqual(v.known_red, SAME_FAILURE.failing, 'master fails the same test, so the branch is not blamed');
    assert.equal(v.action, 'landed', JSON.stringify(v));
    assert.match(v.waited, /^waited 1 minute for the load to settle$/);
  } finally {
    cleanup(root, bare, m.dir);
  }
});

test('the master comparison keeps its turn when earlier waits used up the rest of the run\'s limit', () => {
  const { root, bare } = githubRepo({ older: 'member/blue' });
  // The machine is busy for eleven and a half minutes: the older branch
  // waits ten and gives up, the next waits one and a half and runs. Its check
  // leaves the load high for two more minutes. The branches may wait twelve
  // minutes in all, so only the three kept back let master's check run.
  const m = fakeMachine({ load: 40 });
  m.options = ((base) => (extra) => base({
    sleep: (ms) => {
      m.sleeps.push(ms);
      m.now += ms;
      if (!m.dropped && m.slept() >= 11.5 * MINUTE) { m.dropped = true; m.load = 1; }
      if (m.settleAt && m.now >= m.settleAt) m.load = 2;
    },
    ...extra,
  }))(m.options);
  try {
    const gh = fakeGithub(bare);
    let checks = 0;
    const result = compareRun(root, gh, m, {
      runVerifyFn: () => { checks += 1; m.load = 31; m.settleAt = m.now + 2 * MINUTE; return SAME_FAILURE; },
    });
    const by = Object.fromEntries(result.verdicts.map((x) => [x.branch, x]));
    assert.equal(by['member/blue'].reason, 'machine_busy', JSON.stringify(by['member/blue']));
    assert.match(by['member/blue'].detail, /waited 10 minutes, no local check started/);
    const v = by['member/green'];
    assert.equal(checks, 2, JSON.stringify(v));
    assert.equal(v.action, 'landed', JSON.stringify(v));
    assert.deepEqual(v.known_red, SAME_FAILURE.failing);
    assert.equal(m.slept(), 13.5 * MINUTE);
    assert.equal(result.machine_wait.waited_ms, 13.5 * MINUTE, 'the run limit of fifteen minutes holds');
  } finally {
    cleanup(root, bare, m.dir);
  }
});

test('atris land --auto reads green_landing_wait_minutes: 0 gives up at once on a held lock', () => {
  const root = localRepo(['feat/one']);
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-land-wait-cli-'));
  try {
    fs.mkdirSync(path.join(root, '.atris', 'policy'), { recursive: true });
    fs.writeFileSync(path.join(root, '.atris', 'policy', 'autoland.json'), JSON.stringify({ green_landing_wait_minutes: 0 }));
    holdLock(path.join(state, '.atris', 'locks', 'land-green-local-suite.lock'));
    const marker = path.join(state, 'suite-ran');
    const cli = path.join(__dirname, '..', 'bin', 'atris.js');
    const started = Date.now();
    const out = spawnSync(process.execPath, [cli, 'land', '--auto', '--json', '--no-remote', '--verify', `node -e "require('fs').writeFileSync(${JSON.stringify(marker)}, '1')"`], {
      cwd: root, encoding: 'utf8', timeout: 60000,
      env: { ...process.env, HOME: state, ATRIS_TEST_STATE_DIR: state, ATRIS_NO_BOOT: '1' },
    });
    assert.ok(Date.now() - started < 50000, 'no wait');
    const text = String(out.stdout || '');
    const result = JSON.parse(text.slice(text.indexOf('{')));
    const v = result.verdicts.find((x) => x.branch === 'feat/one');
    assert.equal(v.reason, 'machine_busy', JSON.stringify(v));
    assert.equal(v.detail, 'another local check holds the machine (another-project); no local check started; tries again next run');
    assert.equal(fs.existsSync(marker), false);
    assert.equal(result.machine_wait.limit_ms, 0);
  } finally {
    cleanup(root, state);
  }
});
