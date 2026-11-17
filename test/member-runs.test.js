'use strict';

// Every member run ends landed or dropped (lib/member-runs.js). On the desktop
// app on 2026-11-14, 118 member runs ended by just stopping: 91 never reached
// a pull request and 44 copies stayed on disk. These tests drive the record,
// the finisher, the gate before a new run, and `atris worktree runs` in a temp
// project. No engine, no network: autoland and the feed are faked where a test
// needs them to say something.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const runs = require('../lib/member-runs');

const cli = path.resolve(__dirname, '..', 'bin', 'atris.js');

for (const name of ['CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'ATRIS_CALLER_RUNTIME']) delete process.env[name];

function project(t) {
  const top = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-member-runs-')));
  t.after(() => fs.rmSync(top, { recursive: true, force: true }));
  const main = path.join(top, 'proj');
  fs.mkdirSync(main);
  const git = (cwd, ...args) => {
    const res = spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' });
    assert.equal(res.status, 0, `git ${args.join(' ')}: ${res.stderr}`);
    return res.stdout.trim();
  };
  git(main, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(main, '.gitignore'), '.atris/\n');
  fs.mkdirSync(path.join(main, 'atris', 'team', 'bob'), { recursive: true });
  fs.writeFileSync(path.join(main, 'atris', 'team', 'bob', 'MEMBER.md'), '---\nname: bob\nrole: Builder\n---\n');
  git(main, 'add', '-A');
  git(main, 'commit', '-q', '-m', 'seed');
  let n = 0;
  // A member run's copy: a branch, a copy under .agent-worktrees, and the
  // mission record that mission start --worktree writes inside it.
  const copy = (member = 'bob', { commit = false } = {}) => {
    n += 1;
    const branch = `codex/${member}-next-step-toward-x-20261114-00000${n}`;
    const where = path.join(top, '.agent-worktrees', 'proj', `${member}-step-${n}`);
    git(main, 'worktree', 'add', '-q', '-b', branch, where);
    if (commit) {
      fs.writeFileSync(path.join(where, `work-${n}.txt`), 'work\n');
      git(where, 'add', '-A');
      git(where, 'commit', '-q', '-m', `work ${n}`);
    }
    const mission = {
      id: `mission-${n}`, owner: member, objective: `next step toward: thing ${n}`, status: 'complete',
      created_at: `2026-11-14T00:00:0${n}.000Z`, updated_at: `2026-11-14T00:00:0${n}.000Z`,
      worktree: { path: where, branch, base: 'main' },
    };
    fs.mkdirSync(path.join(where, '.atris', 'state'), { recursive: true });
    fs.writeFileSync(path.join(where, '.atris', 'state', 'missions.jsonl'), `${JSON.stringify(mission)}\n`);
    return { branch, path: where, mission };
  };
  return { top, main, git, copy };
}

function ledger(main) {
  return JSON.parse(fs.readFileSync(path.join(main, '.atris', 'state', 'member-runs.json'), 'utf8')).runs;
}

function runsCheck(cwd) {
  return spawnSync(process.execPath, [cli, 'worktree', 'runs'], {
    cwd, encoding: 'utf8', timeout: 60000, env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1' },
  });
}

const held = (line) => () => ({ merged: false, auto_merge: false, gate: 'review', line: `left the branch for you: ${line}` });
const fakeRemove = (calls) => (options) => {
  calls.push(options);
  return { removed: false, reason: 'kept by the test' };
};

test('a run that committed work and stopped is unfinished, and the check fails on it', (t) => {
  const p = project(t);
  const run = p.copy('bob', { commit: true });
  // The old ending: the run stopped with its work on its branch and nothing
  // recorded. That must read as unfinished, not done.
  const end = runs.settleRunEnd({ mission: run.mission, landing: held('the review did not see the code')() });
  assert.equal(end.state, 'unfinished');
  assert.equal(ledger(p.main)[run.branch].state, 'unfinished');
  const listed = runs.listMemberRuns(p.main).runs;
  assert.deepEqual(listed.map((r) => [r.member, r.branch, r.state]), [['bob', run.branch, 'unfinished']]);
  const check = runsCheck(p.main);
  assert.equal(check.status, 1, check.stdout + check.stderr);
  assert.match(check.stdout, /unfinished {2}bob/);
  assert.ok(fs.existsSync(run.path), 'an unfinished run keeps its copy');
});

test('a copy from before the record counts as unfinished too', (t) => {
  const p = project(t);
  const run = p.copy('bob', { commit: true });
  assert.equal(runs.listMemberRuns(p.main).runs[0].state, 'unfinished');
  assert.equal(runsCheck(run.path).status, 1, 'the check reads the whole project from inside a copy too');
});

test('a run that made no change is dropped: its copy and branch are removed', (t) => {
  const p = project(t);
  const run = p.copy('bob');
  const end = runs.settleRunEnd({ mission: run.mission, landing: held('the check did not pass')(), activePaths: () => [] });
  assert.equal(end.state, 'dropped');
  assert.equal(end.why, 'it made no change');
  assert.equal(fs.existsSync(run.path), false, end.copy_kept || 'copy should be gone');
  assert.equal(spawnSync('git', ['rev-parse', '--verify', '-q', `refs/heads/${run.branch}`], { cwd: p.main }).status, 1);
  assert.equal(ledger(p.main)[run.branch].state, 'dropped');
  assert.equal(runsCheck(p.main).status, 0);
});

test('a run whose work is already in main is landed and its copy is removed', (t) => {
  const p = project(t);
  const run = p.copy('bob', { commit: true });
  p.git(p.main, 'merge', '-q', '--ff-only', run.branch);
  const end = runs.settleRunEnd({ mission: run.mission, activePaths: () => [] });
  assert.equal(end.state, 'landed');
  assert.equal(end.why, 'its work is already in main');
  assert.equal(fs.existsSync(run.path), false, end.copy_kept || 'copy should be gone');
  // The run's own mission record moved to the main checkout, not lost.
  const archived = path.join(p.main, '.atris', 'state', 'member-runs', run.branch.replace(/[^A-Za-z0-9._-]+/g, '_'), '.atris', 'state', 'missions.jsonl');
  assert.equal(JSON.parse(fs.readFileSync(archived, 'utf8')).id, run.mission.id);
});

test('a run autoland handed to the merge line is landed', (t) => {
  const p = project(t);
  const run = p.copy('bob', { commit: true });
  const calls = [];
  const end = runs.settleRunEnd({
    mission: run.mission,
    landing: { merged: false, auto_merge: true, line: 'merges on its own once checks pass: pull request #7' },
    removeCopy: fakeRemove(calls),
  });
  assert.equal(end.state, 'landed');
  assert.equal(calls[0].landedOn, `origin/${run.branch}`, 'the copy goes once its work is safe on origin');
  assert.equal(end.copy_kept, 'kept by the test');
  assert.equal(runsCheck(p.main).status, 0, 'landed with a kept copy is not unfinished');
});

test('a live run is running, and a dead one is unfinished', (t) => {
  const p = project(t);
  const run = p.copy('bob', { commit: true });
  runs.noteRunStart(run.mission);
  assert.equal(runs.listMemberRuns(p.main).runs[0].state, 'running');
  assert.equal(runs.listMemberRuns(p.main, { alive: () => false }).runs[0].state, 'unfinished');
});

test('the next wake tries twice, then asks the owner, keeps the branch, and lets the member move on', (t) => {
  const p = project(t);
  const run = p.copy('bob', { commit: true });
  const other = p.copy('ann', { commit: true });
  const order = [];
  const asked = [];
  const removed = [];
  const out = runs.finishMemberRuns({
    cwd: p.main,
    member: 'bob',
    deps: {
      autoland: ({ cwd }) => { order.push(`land ${cwd === run.path}`); return held('the latest review was not recorded on the code that is checked out now')(); },
      refreshTarget: () => order.push('refresh'),
      ask: (main, ask) => { asked.push(ask); return { card_id: 'card-1' }; },
      removeCopy: fakeRemove(removed),
    },
  });
  assert.deepEqual(order, ['refresh', 'land true', 'refresh', 'land true']);
  assert.equal(out.blocked, false, out.line);
  assert.equal(out.finished[0].state, 'owner');
  assert.equal(asked.length, 1);
  assert.equal(asked[0].member, 'bob');
  assert.equal(asked[0].step, 'next step toward: thing 1');
  assert.match(asked[0].why, /latest review was not recorded/);
  const entry = ledger(p.main)[run.branch];
  assert.equal(entry.state, 'owner');
  assert.equal(entry.card_id, 'card-1');
  assert.equal(spawnSync('git', ['rev-parse', '--verify', '-q', `refs/heads/${run.branch}`], { cwd: p.main }).status, 0, 'the branch stays for the owner');
  // Another member's unfinished run is left for that member's own wake.
  assert.equal(ledger(p.main)[other.branch], undefined);
  const states = Object.fromEntries(runs.listMemberRuns(p.main).runs.map((r) => [r.member, r.state]));
  assert.deepEqual(states, { bob: 'owner', ann: 'unfinished' });
});

test('a second try that lands ends the run landed without asking the owner', (t) => {
  const p = project(t);
  p.copy('bob', { commit: true });
  let tries = 0;
  const out = runs.finishMemberRuns({
    cwd: p.main,
    member: 'bob',
    deps: {
      autoland: () => (++tries === 1 ? held('the branch could not be pushed')() : { merged: false, auto_merge: true, line: 'merges on its own once checks pass: pull request #9' }),
      refreshTarget: () => {},
      ask: () => assert.fail('the owner is not asked when the run lands'),
      removeCopy: fakeRemove([]),
    },
  });
  assert.equal(out.blocked, false);
  assert.equal(out.finished[0].state, 'landed');
  assert.equal(out.finished[0].tries, 2);
});

test('a member with more unfinished runs than one wake finishes stays blocked', (t) => {
  const p = project(t);
  for (let i = 0; i < 4; i += 1) p.copy('bob', { commit: true });
  const out = runs.finishMemberRuns({
    cwd: p.main,
    member: 'bob',
    deps: { autoland: held('a reviewer did not pass it'), refreshTarget: () => {}, ask: () => ({}), removeCopy: fakeRemove([]), max: 3 },
  });
  assert.equal(out.finished.length, 3);
  assert.equal(out.left, 1);
  assert.equal(out.blocked, true);
  assert.match(out.line, /bob is finishing 1 earlier run before starting a new step/);
});

test('a copy with unsaved work is never removed, even when its run ends', (t) => {
  const p = project(t);
  const run = p.copy('bob', { commit: true });
  fs.writeFileSync(path.join(run.path, 'half-done.txt'), 'not saved\n');
  const out = runs.finishMemberRuns({
    cwd: p.main, member: 'bob',
    deps: { autoland: held('unsaved changes; the check may not match what would merge'), refreshTarget: () => {}, ask: () => ({}), activePaths: () => [] },
  });
  assert.equal(out.finished[0].state, 'owner');
  assert.equal(out.finished[0].copy_kept, 'it still has 1 unsaved changes');
  assert.ok(fs.existsSync(path.join(run.path, 'half-done.txt')));
});

test('a held run with only its own record left loses its copy but keeps its branch', (t) => {
  const p = project(t);
  const run = p.copy('bob', { commit: true });
  const out = runs.finishMemberRuns({
    cwd: p.main, member: 'bob',
    deps: { autoland: held('a reviewer did not pass it'), refreshTarget: () => {}, ask: () => ({}), activePaths: () => [] },
  });
  assert.equal(out.finished[0].state, 'owner');
  assert.equal(out.finished[0].copy_removed, true, out.finished[0].copy_kept);
  assert.equal(fs.existsSync(run.path), false);
  assert.equal(spawnSync('git', ['rev-parse', '--verify', '-q', `refs/heads/${run.branch}`], { cwd: p.main }).status, 0);
  // It still shows as waiting on the owner, and the check passes.
  assert.deepEqual(runs.listMemberRuns(p.main).runs.map((r) => r.state), ['owner']);
  assert.equal(runsCheck(p.main).status, 0);
});

test('member run refuses a new step while the member has runs left unfinished', (t) => {
  const p = project(t);
  for (let i = 0; i < 4; i += 1) {
    // Unsaved work keeps each copy, so this test never waits on a process scan.
    const run = p.copy('bob', { commit: true });
    fs.writeFileSync(path.join(run.path, 'half-done.txt'), 'not saved\n');
  }
  const before = spawnSync('git', ['worktree', 'list'], { cwd: p.main, encoding: 'utf8' }).stdout.trim().split('\n').length;
  const res = spawnSync(process.execPath, [cli, 'member', 'run', 'bob', 'a new step', '--verify', 'true', '--json'], {
    cwd: p.main,
    encoding: 'utf8',
    timeout: 120000,
    env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1', ATRIS_TASKS_DB: path.join(p.top, 'tasks.db') },
  });
  const payload = JSON.parse(res.stdout.trim().split('\n').filter((line) => line.startsWith('{')).pop() || '{}');
  assert.equal(payload.started, false, res.stdout + res.stderr);
  assert.match(String(payload.error), /bob is finishing 1 earlier run before starting a new step/);
  const after = spawnSync('git', ['worktree', 'list'], { cwd: p.main, encoding: 'utf8' }).stdout.trim().split('\n').length;
  assert.equal(after, before, 'no new copy was cut');
  // Self-landing is off here, so the three it finished wait on the owner.
  const states = Object.values(ledger(p.main)).map((entry) => entry.state).sort();
  assert.deepEqual(states, ['owner', 'owner', 'owner']);
});

test('member go finishes earlier runs before it takes a job, and waits while any are left', (t) => {
  const p = project(t);
  for (let i = 0; i < 4; i += 1) {
    const run = p.copy('bob', { commit: true });
    fs.writeFileSync(path.join(run.path, 'half-done.txt'), 'not saved\n');
  }
  const res = spawnSync(process.execPath, [cli, 'member', 'go', 'bob', '--needs-check', '--json'], {
    cwd: p.main,
    encoding: 'utf8',
    timeout: 120000,
    env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1', ATRIS_TASKS_DB: path.join(p.top, 'tasks.db') },
  });
  assert.equal(res.status, require('../lib/member-up').IDLE_EXIT, res.stdout + res.stderr);
  const payload = JSON.parse(res.stdout.slice(res.stdout.indexOf('{')));
  assert.equal(payload.mode, 'finishing');
  assert.match(payload.reason, /bob is finishing 1 earlier run/);
});
