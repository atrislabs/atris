'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const taskDb = require('../lib/task-db');

function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-verify-gate-'));
  const db = taskDb.open(path.join(dir, 'tasks.db'));
  return { dir, db };
}

function addPendingReviewTask(db, dir) {
  const result = taskDb.addTask(db, {
    title: 'verify gate test task',
    status: 'review',
    workspaceRoot: dir,
    claimedBy: 'tester',
    metadata: { approval_status: 'pending' },
  });
  return result.id;
}

test('reviewTask refuses to store a verify the strict parser rejects', () => {
  const { dir, db } = freshDb();
  const id = addPendingReviewTask(db, dir);
  assert.throws(
    () => taskDb.reviewTask(db, {
      id,
      actor: 'tester',
      reward: 0,
      verify: "bash -lc 'echo not allowlisted'",
    }),
    (error) => {
      assert.equal(error.reason, 'verify_command_not_allowed');
      assert.match(error.message, /not runnable by the hourly recheck/);
      return true;
    },
  );
  const row = taskDb.getTask(db, id);
  const metadata = row.metadata && typeof row.metadata === 'object' ? row.metadata : JSON.parse(row.metadata || '{}');
  assert.equal(metadata.verify, undefined, 'rejected verify must not be stored');
  taskDb.close();
});

test('reviewTask stores an allowlisted verify', () => {
  const { dir, db } = freshDb();
  const id = addPendingReviewTask(db, dir);
  const result = taskDb.reviewTask(db, {
    id,
    actor: 'tester',
    reward: 0,
    verify: 'test -s package.json',
  });
  assert.equal(result.reviewed, true);
  const row = taskDb.getTask(db, id);
  const metadata = row.metadata && typeof row.metadata === 'object' ? row.metadata : JSON.parse(row.metadata || '{}');
  assert.equal(metadata.verify, 'test -s package.json');
  taskDb.close();
});
