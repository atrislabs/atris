'use strict';

// A task a member keeps failing goes back on the list twice. The third
// failure in a row holds it for a person, so no member picks it up again
// until someone clears the hold.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const taskDb = require('../lib/task-db');
const picker = require('../lib/member-task-pick');
const { memberGoFinishTask } = require('../commands/member');

function withTasks(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-three-strikes-'));
  const dbPath = path.join(root, 'tasks.db');
  taskDb.close();
  process.env.ATRIS_TASKS_DB = dbPath;
  const db = taskDb.open(dbPath);
  t.after(() => {
    taskDb.close();
    delete process.env.ATRIS_TASKS_DB;
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { db, ws: taskDb.workspaceRoot(root) };
}

const failedRun = { started: true, mission_id: 'm-1', mission: { status: 'running' }, error: 'check failed: 2 tests red' };

function failOnce(db, id) {
  // A task sent back after review stays with the member who did it.
  if (taskDb.getTask(db, id).claimed_by !== 'executor') {
    assert.equal(taskDb.claimTask(db, { id, claimedBy: 'executor' }).claimed, true);
  }
  return memberGoFinishTask('executor', taskDb.getTask(db, id), failedRun);
}

test('the third failure in a row holds the task for a person', (t) => {
  const { db, ws } = withTasks(t);
  const { id } = taskDb.addTask(db, { title: 'Fix the flaky clock test', workspaceRoot: ws });

  assert.equal(failOnce(db, id).outcome, 'released');
  assert.equal(failOnce(db, id).outcome, 'released');
  assert.equal(picker.pickTaskForMember(taskDb, db, { workspaceRoot: ws, job: 'build' })?.id, id);

  const third = failOnce(db, id);
  assert.equal(third.outcome, 'needs_human');
  assert.equal(third.reason, 'check failed: 2 tests red');
  const row = taskDb.getTask(db, id);
  assert.equal(row.status, 'open');
  assert.equal(row.claimed_by, null);
  assert.ok(row.metadata.tags.includes('needs-human'));
  assert.equal(picker.skipReason(row, 'build'), 'needs_human');
  assert.equal(picker.pickTaskForMember(taskDb, db, { workspaceRoot: ws, job: 'build' }), null);
  const notes = taskDb.listTaskEvents(db, { taskId: id }).map((e) => e.payload?.content || '');
  assert.ok(notes.some((n) => /Held for a person: failed 3 times in a row\. Last reason: check failed/.test(n)));
});

test('a person clearing the hold gives the task three fresh tries', (t) => {
  const { db, ws } = withTasks(t);
  const { id } = taskDb.addTask(db, { title: 'Rename the stale flag', workspaceRoot: ws });
  for (let i = 0; i < 3; i++) failOnce(db, id);
  taskDb.tagTask(db, { id, actor: 'keshav', remove: ['needs-human'] });

  assert.equal(failOnce(db, id).outcome, 'released');
  assert.equal(failOnce(db, id).outcome, 'released');
  assert.equal(failOnce(db, id).outcome, 'needs_human');
});

test('failures split by a passing run do not add up', (t) => {
  const { db, ws } = withTasks(t);
  const { id } = taskDb.addTask(db, { title: 'Tidy the board copy', workspaceRoot: ws });
  failOnce(db, id);
  failOnce(db, id);
  taskDb.claimTask(db, { id, claimedBy: 'executor' });
  const passed = memberGoFinishTask('executor', taskDb.getTask(db, id), {
    started: true, mission_id: 'm-2', mission: { status: 'complete', verifier_result: { passed: true } },
  });
  assert.equal(passed.outcome, 'review');
  assert.equal(taskDb.reviseTask(db, { id, actor: 'keshav', note: 'close, but the copy is still long' }).revised, true);

  assert.equal(failOnce(db, id).outcome, 'released');
  assert.equal(failOnce(db, id).outcome, 'released');
  assert.equal(failOnce(db, id).outcome, 'needs_human');
});
