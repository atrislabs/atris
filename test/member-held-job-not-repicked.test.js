'use strict';

// A member's work that touches a protected file (auth, payments, deploys) is
// held for a person to review. The job must wait for that person: the next
// wake must not pick it up, redo it, and get held again.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const taskDb = require('../lib/task-db');
const picker = require('../lib/member-task-pick');
const { inspectMissionProtectedDiff } = require('../lib/mission-protected-lane');
const { memberGoFinishTask, memberRunReviewAsk } = require('../commands/member');

function withTasks(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-held-job-'));
  const dbPath = path.join(root, 'tasks.db');
  taskDb.close();
  process.env.ATRIS_TASKS_DB = dbPath;
  const db = taskDb.open(dbPath);
  t.after(() => {
    taskDb.close();
    delete process.env.ATRIS_TASKS_DB;
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { db, root, ws: taskDb.workspaceRoot(root) };
}

// A checkout where the member staged a change to an auth file.
function stagedAuthChange(root) {
  const repo = path.join(root, 'checkout');
  fs.mkdirSync(path.join(repo, 'lib'), { recursive: true });
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  fs.writeFileSync(path.join(repo, 'lib', 'auth.js'), 'module.exports = {};\n');
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  fs.writeFileSync(path.join(repo, 'lib', 'auth.js'), 'module.exports = { retry: true };\n');
  git('add', '.');
  return repo;
}

// The run result member run hands back when the protected guard pauses it.
function heldRun(repo) {
  const guard = inspectMissionProtectedDiff({ root: repo, baseRef: 'HEAD' });
  assert.equal(guard.allowed, false);
  assert.deepEqual(guard.surfaces, ['auth']);
  const payload = { ok: false, ran_ticks: 1, ticks: [{ ran: true, protected_lane_guard: guard }] };
  const mission = { id: 'm-held', status: 'paused' };
  const ask = memberRunReviewAsk('builder', payload, mission, repo);
  return { ...payload, ok: false, started: true, mission_id: mission.id, mission, ...ask, error: ask.ask };
}

test('work held for review on an auth file is not picked by the next wake', (t) => {
  const { db, root, ws } = withTasks(t);
  const { id } = taskDb.addTask(db, {
    title: 'The login retry test stops failing',
    workspaceRoot: ws,
    metadata: { verify: 'node --test test/agent-client.test.js' },
  });
  assert.equal(taskDb.claimTask(db, { id, claimedBy: 'builder' }).claimed, true);

  const finished = memberGoFinishTask('builder', taskDb.getTask(db, id), heldRun(stagedAuthChange(root)));
  assert.equal(finished.outcome, 'needs_human');
  assert.equal(finished.held_for, 'review');
  assert.match(finished.reason, /staged a change that touches auth/);

  const row = taskDb.getTask(db, id);
  assert.equal(row.claimed_by, null);
  assert.ok(row.metadata.tags.includes('needs-human'));
  assert.equal(picker.skipReason(row, 'build'), 'needs_human');
  // Plain wake and member up (which needs a runnable check) both pass it by.
  assert.equal(picker.pickTaskForMember(taskDb, db, { workspaceRoot: ws, job: 'build' }), null);
  assert.equal(picker.pickTaskForMember(taskDb, db, { workspaceRoot: ws, job: 'build', requireCheck: true }), null);
  assert.equal(picker.claimTaskForMember(taskDb, db, { workspaceRoot: ws, member: 'builder', job: 'build' }), null);
  const notes = taskDb.listTaskEvents(db, { taskId: id }).map((e) => e.payload?.content || '');
  assert.ok(notes.some((n) => /^Held for a person to review: builder staged a change that touches auth/.test(n)));

  // Once a person clears the hold, members can pick it up again.
  taskDb.tagTask(db, { id, actor: 'keshav', remove: ['needs-human'] });
  assert.equal(picker.pickTaskForMember(taskDb, db, { workspaceRoot: ws, job: 'build' })?.id, id);
});

test('a plain failed run still goes back on the list', (t) => {
  const { db, ws } = withTasks(t);
  const { id } = taskDb.addTask(db, { title: 'Fix the flaky clock test', workspaceRoot: ws });
  assert.equal(taskDb.claimTask(db, { id, claimedBy: 'builder' }).claimed, true);

  const failed = { started: true, mission_id: 'm-1', mission: { status: 'running' }, error: 'check failed: 2 tests red' };
  const finished = memberGoFinishTask('builder', taskDb.getTask(db, id), failed);
  assert.equal(finished.outcome, 'released');
  assert.equal(finished.held_for, undefined);
  assert.equal(picker.pickTaskForMember(taskDb, db, { workspaceRoot: ws, job: 'build' })?.id, id);
});
