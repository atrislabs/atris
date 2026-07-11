'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const taskDb = require('../lib/task-db');
const { sweepWishes } = require('../lib/wish-delegate');

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-wish-autoclose-'));
  fs.mkdirSync(path.join(root, 'atris'), { recursive: true });
  return root;
}

function appendWish(root, record) {
  const file = path.join(root, '.atris', 'state', 'wishes.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
}

function readWishes(root) {
  return fs.readFileSync(path.join(root, '.atris', 'state', 'wishes.jsonl'), 'utf8')
    .trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
}

function addTask(db, root, status) {
  return taskDb.addTask(db, {
    title: `${status} wish task`,
    workspaceRoot: root,
    status,
    claimedBy: status === 'claimed' ? 'builder' : undefined,
  }).id;
}

test('wish sweep fulfills landed delegated work once and leaves other wishes untouched', () => {
  const root = workspace();
  const dbPath = path.join(root, '.atris', 'tasks.db');
  try {
    const db = taskDb.open(dbPath);
    const doneTaskId = addTask(db, root, 'claimed');
    assert.equal(taskDb.doneTask(db, { id: doneTaskId, actor: 'builder' }).updated, true);
    const claimedTaskId = addTask(db, root, 'claimed');
    const closedTaskId = addTask(db, root, 'done');
    appendWish(root, {
      id: 'wish-landed', status: 'delegated', task_id: doneTaskId,
      mission_id: 'mission-landed', ts: new Date().toISOString(),
    });
    appendWish(root, {
      id: 'wish-active', status: 'delegated', task_id: claimedTaskId,
      mission_id: 'mission-active', ts: new Date().toISOString(),
    });
    appendWish(root, {
      id: 'wish-closed', status: 'delegated', task_id: closedTaskId,
      mission_id: 'mission-closed', ts: new Date().toISOString(),
    });
    appendWish(root, {
      id: 'wish-closed', kind: 'closed', status: 'closed',
      task_id: closedTaskId, mission_id: 'mission-closed', ts: new Date().toISOString(),
    });

    const first = sweepWishes(root, { dbPath });
    assert.equal(first.fulfilled, 1);
    assert.equal(first.fulfilled_results.length, 1);
    assert.equal(first.fulfilled_results[0].wish_id, 'wish-landed');
    assert.equal(first.fulfilled_results[0].task_status, 'done');
    assert.equal(
      first.fulfilled_results[0].review_ask,
      'atris wish review wish-landed "<your line>" [--score]',
    );

    const afterFirst = readWishes(root);
    assert.equal(afterFirst.filter((record) => record.status === 'fulfilled').length, 1);
    assert.equal(afterFirst.at(-1).kind, 'fulfilled');

    const second = sweepWishes(root, { dbPath });
    assert.equal(second.fulfilled, 0);
    assert.deepEqual(second.fulfilled_results, []);
    const afterSecond = readWishes(root);
    assert.equal(afterSecond.filter((record) => record.status === 'fulfilled').length, 1);
    assert.equal(afterSecond.some((record) => record.id === 'wish-active' && record.status === 'fulfilled'), false);
    assert.equal(afterSecond.some((record) => record.id === 'wish-closed' && record.status === 'fulfilled'), false);
  } finally {
    taskDb.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
