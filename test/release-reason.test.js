'use strict';

// A claim the flight lets go carries a reason. Without one, `atris rating`
// scored good work that stalled at the ship gate as a plain, reasonless drop.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const tasks = require('../lib/task-db');
const { scrubAgentEnv } = require('./helpers/agent-env');
const { loadSeason } = require('../lib/gm-season');
const { ratingCommand } = require('../commands/rating');
const { releasePausedClaimsWithoutWork } = require('../lib/fleet');

const CLI = path.resolve(__dirname, '..', 'bin', 'atris.js');

function tempDb(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-reason-'));
  const dbPath = path.join(dir, 'tasks.db');
  const saved = process.env.ATRIS_TASKS_DB;
  // ratingCommand checks for expired claims in the task db it finds by env.
  process.env.ATRIS_TASKS_DB = dbPath;
  const db = tasks.open(dbPath);
  t.after(() => {
    tasks.close();
    if (saved === undefined) delete process.env.ATRIS_TASKS_DB; else process.env.ATRIS_TASKS_DB = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, dbPath, db };
}

function claim(db, dir, title, actor = 'fleet-codex') {
  const { id } = tasks.addTask(db, { title, workspaceRoot: dir });
  assert.equal(tasks.claimTask(db, { id, claimedBy: actor }).claimed, true);
  return id;
}

const releasePayload = (db, id) => JSON.parse(
  db.prepare("SELECT payload FROM task_events WHERE task_id = ? AND event_type = 'claim_released'").get(id).payload,
);

test('a release keeps its reason on one line, capped, and stays as before without one', (t) => {
  const { dir, db } = tempDb(t);
  const stalled = claim(db, dir, 'stalled at ship');
  const long = `paused at ship: ${'x'.repeat(400)}\nsecond line`;
  assert.equal(tasks.releaseTask(db, { id: stalled, actor: 'fleet-codex', reason: long }).released, true);
  const reason = releasePayload(db, stalled).reason;
  assert.match(reason, /^paused at ship: xxx/);
  assert.ok(reason.length <= 300, `reason is ${reason.length} chars`);
  assert.doesNotMatch(reason, /\n/);

  const plain = claim(db, dir, 'plain release');
  assert.equal(tasks.releaseTask(db, { id: plain, actor: 'fleet-codex' }).released, true);
  assert.deepEqual(releasePayload(db, plain), { released_by: 'fleet-codex', previous_claimed_by: 'fleet-codex' });

  const blank = claim(db, dir, 'blank reason');
  assert.equal(tasks.releaseTask(db, { id: blank, actor: 'fleet-codex', reason: '   ' }).released, true);
  assert.equal(releasePayload(db, blank).reason, undefined);
});

test('atris task release --reason saves the reason and says it back', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-reason-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'atris'));
  const dbPath = path.join(dir, 'tasks.db');
  const run = (args) => {
    const result = spawnSync(process.execPath, [CLI, ...args], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 30000,
      env: { ...scrubAgentEnv(), ATRIS_TASKS_DB: dbPath, ATRIS_SKIP_UPDATE_CHECK: '1', NODE_NO_WARNINGS: '1' },
    });
    assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr || result.stdout}`);
    return result;
  };
  const taskOf = (title) => JSON.parse(run(['task', 'new', title, '--json']).stdout).task.display_id;

  const withReason = taskOf('Release with a reason');
  run(['task', 'claim', withReason, '--as', 'fleet-codex']);
  const released = JSON.parse(run(['task', 'release', withReason, '--as', 'fleet-codex', '--reason', 'paused at verify: 1 failing test', '--json']).stdout);
  assert.equal(released.ok, true);
  assert.equal(released.reason, 'paused at verify: 1 failing test');

  const without = taskOf('Release with no reason');
  run(['task', 'claim', without, '--as', 'fleet-codex']);
  const bare = JSON.parse(run(['task', 'release', without, '--as', 'fleet-codex', '--json']).stdout);
  assert.equal(bare.reason, null);

  const reader = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const payloads = reader.prepare("SELECT payload FROM task_events WHERE event_type = 'claim_released' ORDER BY created_at, version").all()
      .map((row) => JSON.parse(row.payload));
    assert.deepEqual(payloads.map((p) => p.reason), ['paused at verify: 1 failing test', undefined]);
  } finally {
    reader.close();
  }
});

function repoWithCommit(t, { commit }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-reason-repo-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: dir, encoding: 'utf8' });
  git('init', '-q', '-b', 'master');
  git('commit', '-q', '--allow-empty', '-m', 'base');
  git('tag', 'base');
  if (commit) {
    fs.writeFileSync(path.join(dir, 'fix.js'), 'module.exports = 1;\n');
    git('add', 'fix.js');
    git('commit', '-q', '-m', 'the fix');
  }
  return dir;
}

function releaseCalls(rows, { keepClaimsWithWork, baseRef = 'base', worktree = '' } = {}) {
  const calls = [];
  releasePausedClaimsWithoutWork((args) => { calls.push(args); return { status: 0 }; }, {
    paused: rows,
    worktreeByTask: new Map(rows.map((row) => [row.task, worktree])),
    actorByTask: new Map(rows.map((row) => [row.task, 'fleet-codex'])),
    baseRef,
    keepClaimsWithWork,
  });
  return calls;
}

test('the flight says why it let go: the stage and the first line of the detail', (t) => {
  const worktree = repoWithCommit(t, { commit: true });
  const calls = releaseCalls([
    { task: 'BCK-1', stage: 'verify_failed', detail: '\n  1 failing: widget renders twice\nat widget.test.js:12' },
    { task: 'BCK-2', stage: 'ship', detail: `blocked: could not push\n${'y'.repeat(500)}` },
    { task: 'BCK-3', stage: 'build', reason: 'usage_limit' },
  ], { keepClaimsWithWork: false, worktree });
  const reasons = Object.fromEntries(calls.map((args) => [args[2], args[args.indexOf('--reason') + 1]]));
  assert.equal(reasons['BCK-1'], 'paused at verify: 1 failing: widget renders twice');
  assert.equal(reasons['BCK-2'], 'paused at ship: blocked: could not push');
  assert.equal(reasons['BCK-3'], 'paused at build: usage_limit');
  for (const args of calls) assert.deepEqual(args.slice(3, 5), ['--as', 'fleet-codex']);
});

test('a worker that changed nothing is released as "engine produced no work", in both release modes', (t) => {
  const worktree = repoWithCommit(t, { commit: false });
  for (const keepClaimsWithWork of [true, false]) {
    const calls = releaseCalls([{ task: 'BCK-4', stage: 'ship', detail: 'gh pr merge failed' }], { keepClaimsWithWork, worktree });
    assert.equal(calls.length, 1);
    assert.equal(calls[0][calls[0].indexOf('--reason') + 1], 'engine produced no work');
  }
});

test('a pause where the engine never finished its turn keeps its own reason, even with nothing in the worktree', (t) => {
  const worktree = repoWithCommit(t, { commit: false });
  const calls = releaseCalls([
    { task: 'BCK-6', stage: 'build', reason: 'usage_limit', detail: 'Error: you hit your usage limit\nstack line' },
    { task: 'BCK-7', stage: 'prepare', detail: 'could not write the brief' },
    { task: 'BCK-8', stage: 'verify_failed', detail: '1 failing: widget renders twice' },
  ], { keepClaimsWithWork: false, worktree });
  const reasons = Object.fromEntries(calls.map((args) => [args[2], args[args.indexOf('--reason') + 1]]));
  assert.equal(reasons['BCK-6'], 'paused at build: usage_limit');
  assert.equal(reasons['BCK-7'], 'paused at prepare: could not write the brief');
  // The engine did finish here and changed nothing: that one is "no work".
  assert.equal(reasons['BCK-8'], 'engine produced no work');
});

test('a pull request waiting for a person keeps its claim, even when saving the proof failed', (t) => {
  const worktree = repoWithCommit(t, { commit: false });
  const rows = [{ task: 'BCK-5', stage: 'task_ready', held_for_review: true, worktree }];
  assert.deepEqual(releaseCalls(rows, { keepClaimsWithWork: false, worktree }), []);
  assert.equal(rows[0].claim_released, undefined);
});

test('atris rating shows the reasons the flight gave for the claims it released', (t) => {
  const { dir, dbPath, db } = tempDb(t);
  const verify = 'paused at verify: widget renders twice';
  for (const [title, reason] of [['one', verify], ['two', verify], ['three', 'engine produced no work'], ['four', undefined]]) {
    const id = claim(db, dir, title);
    assert.equal(tasks.releaseTask(db, { id, actor: 'fleet-codex', reason }).released, true);
  }
  const season = loadSeason(dir, { dbPath, now: Date.now() + 1000, lastSeen: null });
  assert.equal(season.error, undefined);

  let text = '';
  assert.equal(ratingCommand(['fleet-codex'], { root: dir, season, lineup: null, write: (s) => { text += s; } }), 0);
  assert.match(text, /landed 0 of 4 finished jobs/);
  assert.match(text, /top miss reasons:/);
  assert.match(text, new RegExp(`2: ${verify}`));
  assert.match(text, /1: engine produced no work/);

  let json = '';
  ratingCommand(['fleet-codex', '--json'], { root: dir, season, lineup: null, write: (s) => { json += s; } });
  assert.deepEqual(JSON.parse(json).member.miss_reasons, [
    { reason: verify, count: 2 },
    { reason: 'engine produced no work', count: 1 },
  ]);
});
