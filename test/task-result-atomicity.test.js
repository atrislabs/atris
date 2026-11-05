'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const taskDb = require('../lib/task-db');

test('task result does not erase another writer’s metadata', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'task-result-atomic-'));
  const db = taskDb.open(path.join(tmp, 'tasks.db'));
  const other = new DatabaseSync(path.join(tmp, 'tasks.db'));
  other.exec('PRAGMA busy_timeout = 0');
  try {
    const { id } = taskDb.addTask(db, { title: 'task', workspaceRoot: tmp, metadata: { initial: true } });
    let attempted = false;
    let blocked = false;
    const wrapped = {
      get isTransaction() { return db.isTransaction; },
      exec: db.exec.bind(db),
      prepare(sql) {
        const statement = db.prepare(sql);
        if (!attempted && /SELECT id, title, status, tag, workspace_root/.test(sql)) {
          return {
            get(...args) {
              const row = statement.get(...args);
              attempted = true;
              try {
                other.prepare("UPDATE tasks SET metadata = json_set(metadata, '$.concurrent', 'keep') WHERE id = ?").run(id);
              } catch (error) {
                if (!/locked|busy/i.test(String(error.message))) throw error;
                blocked = true;
              }
              return row;
            },
          };
        }
        return statement;
      },
    };
    assert.equal(taskDb.setTaskResult(wrapped, { id, actor: 'test', result: 'done' }).saved, true);
    if (blocked) other.prepare("UPDATE tasks SET metadata = json_set(metadata, '$.concurrent', 'keep') WHERE id = ?").run(id);
    const saved = taskDb.getTask(db, id);
    assert.equal(saved.metadata.result, 'done');
    assert.equal(saved.metadata.concurrent, 'keep');
  } finally {
    other.close();
    taskDb.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('result event failure rolls back the metadata change', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'task-result-rollback-'));
  const db = taskDb.open(path.join(tmp, 'tasks.db'));
  try {
    const { id } = taskDb.addTask(db, { title: 'task', workspaceRoot: tmp, metadata: { initial: true } });
    const before = taskDb.getTask(db, id).metadata;
    db.exec("CREATE TRIGGER fail_result BEFORE INSERT ON task_events WHEN NEW.event_type = 'result_set' BEGIN SELECT RAISE(ABORT, 'synthetic result failure'); END");
    assert.throws(() => taskDb.setTaskResult(db, { id, actor: 'test', result: 'done' }), /synthetic result failure/);
    assert.deepEqual(taskDb.getTask(db, id).metadata, before);
  } finally {
    taskDb.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
