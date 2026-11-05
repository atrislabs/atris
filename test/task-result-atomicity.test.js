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

for (const kind of ['revise', 'review', 'archive']) {
  test(`${kind} does not overwrite a concurrent result`, () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `task-${kind}-atomic-`));
    fs.mkdirSync(path.join(tmp, '.atris', 'state'), { recursive: true });
    const db = taskDb.open(path.join(tmp, 'tasks.db'));
    const other = new DatabaseSync(path.join(tmp, 'tasks.db'));
    other.exec('PRAGMA busy_timeout = 0');
    try {
      const { id } = taskDb.addTask(db, { title: 'task', workspaceRoot: tmp, metadata: { initial: true } });
      db.prepare("UPDATE tasks SET status = 'review' WHERE id = ?").run(id);
      let attempted = false;
      let blocked = false;
      const wrapped = {
        get isTransaction() { return db.isTransaction; },
        exec: db.exec.bind(db),
        prepare(sql) {
          const statement = db.prepare(sql);
          if (!attempted && /SELECT id, title, status, tag, workspace_root/.test(sql)) {
            return { get(...args) {
              const row = statement.get(...args);
              attempted = true;
              try {
                other.prepare("UPDATE tasks SET metadata = json_set(metadata, '$.result', 'concurrent result') WHERE id = ?").run(id);
              } catch (error) {
                if (!/locked|busy/i.test(String(error.message))) throw error;
                blocked = true;
              }
              return row;
            } };
          }
          return statement;
        },
      };
      const out = kind === 'revise'
        ? taskDb.reviseTask(wrapped, { id, actor: 'reviewer', note: 'Please revise' })
        : kind === 'review'
          ? taskDb.reviewTask(wrapped, { id, actor: 'reviewer', reward: 0, landing: { checked: 'Checked it' } })
          : taskDb.archiveTask(wrapped, { id, actor: 'reviewer', reason: 'No longer needed', skipLogs: true });
      assert.equal(out[`${kind === 'revise' ? 'revised' : kind === 'review' ? 'reviewed' : 'archived'}`], true);
      if (blocked) other.prepare("UPDATE tasks SET metadata = json_set(metadata, '$.result', 'concurrent result') WHERE id = ?").run(id);
      assert.equal(taskDb.getTask(db, id).metadata.result, 'concurrent result');
    } finally {
      other.close();
      taskDb.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test(`${kind} rolls back row changes when its event cannot be stored`, () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `task-${kind}-rollback-`));
    fs.mkdirSync(path.join(tmp, '.atris', 'state'), { recursive: true });
    const db = taskDb.open(path.join(tmp, 'tasks.db'));
    try {
      const { id } = taskDb.addTask(db, { title: 'task', workspaceRoot: tmp });
      db.prepare("UPDATE tasks SET status = 'review' WHERE id = ?").run(id);
      const before = taskDb.getTask(db, id);
      const eventType = kind === 'revise' ? 'revision_requested' : kind === 'review' ? 'reviewed' : 'archived';
      db.exec(`CREATE TRIGGER fail_event BEFORE INSERT ON task_events WHEN NEW.event_type = '${eventType}' BEGIN SELECT RAISE(ABORT, 'synthetic event failure'); END`);
      assert.throws(() => {
        if (kind === 'revise') taskDb.reviseTask(db, { id, actor: 'reviewer', note: 'Please revise' });
        else if (kind === 'review') taskDb.reviewTask(db, { id, actor: 'reviewer', reward: 0, landing: { checked: 'Checked it' } });
        else taskDb.archiveTask(db, { id, actor: 'reviewer', reason: 'No longer needed', skipLogs: true });
      }, /synthetic event failure/);
      assert.deepEqual(taskDb.getTask(db, id), before);
    } finally {
      taskDb.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
}

test('archived relabel reloads metadata after the candidate listing', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'task-relabel-atomic-'));
  const db = taskDb.open(path.join(tmp, 'tasks.db'));
  const other = new DatabaseSync(path.join(tmp, 'tasks.db'));
  try {
    const { id } = taskDb.addTask(db, {
      title: 'task', workspaceRoot: tmp,
      metadata: { archived_at: '2026-06-10', archive_reason: 'first-principles backlog reset 2026-06-10' },
    });
    db.prepare("UPDATE tasks SET status = 'failed' WHERE id = ?").run(id);
    let intervened = false;
    const wrapped = {
      get isTransaction() { return db.isTransaction; },
      exec: db.exec.bind(db),
      prepare(sql) {
        const statement = db.prepare(sql);
        if (!intervened && /SELECT id, title, status, tag, workspace_root/.test(sql)) {
          return { all(...args) {
            const rows = statement.all(...args);
            intervened = true;
            assert.equal(taskDb.setTaskResult(other, { id, actor: 'other', result: 'later result' }).saved, true);
            return rows;
          } };
        }
        return statement;
      },
    };
    const outcome = taskDb.relabelArchivedTasks(wrapped, { apply: true, actor: 'reviewer' });
    assert.equal(outcome.count, 1);
    assert.equal(taskDb.getTask(db, id).metadata.result, 'later result');
  } finally {
    other.close();
    taskDb.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
