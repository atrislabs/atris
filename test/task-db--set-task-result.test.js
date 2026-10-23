'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-set-task-result-'));
const savedEnv = {};
for (const key of Object.keys(process.env)) {
  if (key.startsWith('ATRIS_')) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
}
savedEnv.HOME = process.env.HOME;
savedEnv.USER = process.env.USER;
process.env.HOME = tmpRoot;
delete process.env.USER;

const taskDb = require('../lib/task-db');

const WORKSPACE = path.join(tmpRoot, 'workspace');
let dbCount = 0;

function freshDb() {
  taskDb.close();
  dbCount += 1;
  return taskDb.open(path.join(tmpRoot, `tasks-${dbCount}.db`));
}

function eventsFor(db, taskId) {
  return db.prepare('SELECT * FROM task_events WHERE task_id = ? ORDER BY version').all(taskId);
}

before(() => {
  fs.mkdirSync(WORKSPACE, { recursive: true });
});

after(() => {
  taskDb.close();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('saves the result on the task and records a result_set event', () => {
  const db = freshDb();
  const { id } = taskDb.addTask(db, {
    title: 'ship the thing',
    workspaceRoot: WORKSPACE,
    metadata: { custom_note: 'keep me' },
  });

  const out = taskDb.setTaskResult(db, { id, actor: 'builder-1', result: 'The thing shipped.' });

  assert.strictEqual(out.saved, true);
  assert.strictEqual(out.row.id, id);
  assert.strictEqual(out.row.status, 'open');
  assert.strictEqual(out.row.title, 'ship the thing');
  assert.strictEqual(out.row.metadata.result, 'The thing shipped.');
  assert.strictEqual(out.row.metadata.result_by, 'builder-1');
  assert.strictEqual(out.row.metadata.custom_note, 'keep me');

  const resultAt = out.row.metadata.result_at;
  assert.strictEqual(new Date(resultAt).toISOString(), resultAt);
  assert.strictEqual(out.row.updated_at, Date.parse(resultAt));

  assert.strictEqual(out.event.event_type, 'result_set');
  assert.strictEqual(out.event.task_id, id);
  assert.strictEqual(out.event.actor, 'builder-1');
  assert.strictEqual(out.event.version, 2);
  assert.deepStrictEqual(out.event.payload, { result: 'The thing shipped.' });

  const stored = taskDb.getTask(db, id);
  assert.deepStrictEqual(stored.metadata, out.row.metadata);
  const events = eventsFor(db, id);
  assert.deepStrictEqual(events.map((e) => e.event_type), ['created', 'result_set']);
  assert.deepStrictEqual(JSON.parse(events[1].payload), { result: 'The thing shipped.' });
});

test('collapses whitespace in the result and overwrites an earlier one', () => {
  const db = freshDb();
  const { id } = taskDb.addTask(db, { title: 'tidy the notes', workspaceRoot: WORKSPACE });

  const first = taskDb.setTaskResult(db, { id, actor: 'a', result: '  first\n\tdraft   done  ' });
  assert.strictEqual(first.row.metadata.result, 'first draft done');
  assert.strictEqual(first.event.version, 2);

  const second = taskDb.setTaskResult(db, { id, actor: 'b', result: 'final answer' });
  assert.strictEqual(second.saved, true);
  assert.strictEqual(second.event.version, 3);
  assert.strictEqual(second.row.metadata.result, 'final answer');
  assert.strictEqual(second.row.metadata.result_by, 'b');
  assert.strictEqual(taskDb.getTask(db, id).metadata.result, 'final answer');
  assert.strictEqual(eventsFor(db, id).length, 3);
});

test('result_by falls back to ATRIS_AGENT_ID, then USER, then null', () => {
  const db = freshDb();
  const { id } = taskDb.addTask(db, { title: 'who did it', workspaceRoot: WORKSPACE });
  try {
    process.env.ATRIS_AGENT_ID = 'agent-from-env';
    process.env.USER = 'user-from-env';
    const viaAgent = taskDb.setTaskResult(db, { id, result: 'one' });
    assert.strictEqual(viaAgent.row.metadata.result_by, 'agent-from-env');
    assert.strictEqual(viaAgent.event.actor, 'agent-from-env');

    delete process.env.ATRIS_AGENT_ID;
    const viaUser = taskDb.setTaskResult(db, { id, result: 'two' });
    assert.strictEqual(viaUser.row.metadata.result_by, 'user-from-env');

    delete process.env.USER;
    const viaNothing = taskDb.setTaskResult(db, { id, result: 'three' });
    assert.strictEqual(viaNothing.row.metadata.result_by, null);
    assert.strictEqual(viaNothing.event.actor, null);

    const explicit = taskDb.setTaskResult(db, { id, actor: 'explicit', result: 'four' });
    assert.strictEqual(explicit.row.metadata.result_by, 'explicit');
  } finally {
    delete process.env.ATRIS_AGENT_ID;
    delete process.env.USER;
  }
});

test('starts fresh metadata when the stored metadata cannot be read', () => {
  const db = freshDb();
  const { id } = taskDb.addTask(db, { title: 'broken metadata', workspaceRoot: WORKSPACE });
  db.prepare('UPDATE tasks SET metadata = ? WHERE id = ?').run('{not json', id);
  assert.strictEqual(taskDb.getTask(db, id).metadata_unreadable, true);

  const out = taskDb.setTaskResult(db, { id, actor: 'fixer', result: 'recovered' });

  assert.strictEqual(out.saved, true);
  assert.deepStrictEqual(
    Object.keys(out.row.metadata).sort(),
    ['result', 'result_at', 'result_by'],
  );
  assert.strictEqual(out.row.metadata.result, 'recovered');
  assert.strictEqual(out.row.metadata_unreadable, undefined);
});

test('throws when id is missing or the result is empty', () => {
  const db = freshDb();
  const { id } = taskDb.addTask(db, { title: 'needs input', workspaceRoot: WORKSPACE });

  assert.throws(() => taskDb.setTaskResult(db, { result: 'x' }), /id required/);
  assert.throws(() => taskDb.setTaskResult(db, { id: '', result: 'x' }), /id required/);
  assert.throws(() => taskDb.setTaskResult(db, { id }), /result required/);
  assert.throws(() => taskDb.setTaskResult(db, { id, result: '' }), /result required/);
  assert.throws(() => taskDb.setTaskResult(db, { id, result: ' \n\t ' }), /result required/);
  assert.throws(() => taskDb.setTaskResult(db, { id, result: null }), /result required/);
  // The empty result is rejected before the task is even looked up.
  assert.throws(() => taskDb.setTaskResult(db, { id: 'no-such-task' }), /result required/);

  const task = taskDb.getTask(db, id);
  assert.strictEqual(task.metadata.result, undefined);
  assert.strictEqual(eventsFor(db, id).length, 1);
});

test('reports not_found for an unknown id and writes nothing', () => {
  const db = freshDb();
  const { id } = taskDb.addTask(db, { title: 'the only task', workspaceRoot: WORKSPACE });

  const out = taskDb.setTaskResult(db, { id: 'no-such-task', actor: 'a', result: 'lost' });

  assert.deepStrictEqual(out, { saved: false, reason: 'not_found' });
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM task_events').get().n, 1);
  assert.strictEqual(taskDb.getTask(db, id).metadata.result, undefined);
});
