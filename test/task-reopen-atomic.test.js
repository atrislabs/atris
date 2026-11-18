'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');
const tasks = require('../lib/task-db');

if (process.env.ATRIS_REOPEN_FIXTURE_WORKER === '1') {
  const db = tasks.open(process.env.ATRIS_REOPEN_FIXTURE_DB);
  process.send('ready');
  process.on('message', message => {
    if (message !== 'go') return;
    let connection = db;
    if (process.env.ATRIS_REOPEN_FIXTURE_PAUSE === 'event') {
      connection = {
        exec: sql => db.exec(sql),
        prepare(sql) {
          if (sql.includes('INSERT INTO task_events')) {
            process.send('before-event');
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
          }
          return db.prepare(sql);
        },
      };
    }
    try {
      const result = tasks.reopenTask(connection, { id: process.env.ATRIS_REOPEN_FIXTURE_TASK, actor: 'fixture' });
      process.send({ result }, () => process.exit(0));
    } catch (error) {
      process.send({ error: String(error.message) }, () => process.exit(1));
    }
  });
} else {
  function fixture(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-reopen-atomic-'));
    const file = path.join(dir, 'tasks.db');
    const ws = path.join(dir, 'workspace');
    const db = tasks.open(file);
    t.after(() => { tasks.close(); fs.rmSync(dir, { recursive: true, force: true }); });
    return { dir, file, ws, db };
  }
  function setup(f) {
    return tasks.addTask(f.db, { title: 'Fixture', workspaceRoot: f.ws, status: 'done', metadata: { built_by: 'worker', agent_review_actors: ['worker', 'reviewer'], independent_review_by: 'reviewer', keep: 'value' } });
  }
  function reopen(db, id) { return tasks.reopenTask(db, { id, actor: 'owner' }); }
  function events(db, id) { return tasks.listTaskEvents(db, { taskId: id }); }
  function launch(t, f, item, pause = '') {
    const child = fork(__filename, [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: {
      ...process.env, NODE_NO_WARNINGS: '1', ATRIS_REOPEN_FIXTURE_WORKER: '1', ATRIS_REOPEN_FIXTURE_DB: f.file,
      ATRIS_REOPEN_FIXTURE_TASK: item.id, ATRIS_REOPEN_FIXTURE_PAUSE: pause,
    } });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    const messages = [], pending = [];
    child.on('message', message => { if (pending.length) pending.shift()(message); else messages.push(message); });
    const next = () => messages.length ? Promise.resolve(messages.shift()) : new Promise(resolve => pending.push(resolve));
    const exited = new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal, stderr })));
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
    return { child, next, exited };
  }

  test('reopen commits the reset and exactly one matching event', t => {
    const f = fixture(t), item = setup(f), before = events(f.db, item.id);
    const result = reopen(f.db, item.id);
    assert.equal(result.reopened, true);
    assert.equal(result.row.status, 'open');
    assert.equal(result.row.metadata.keep, 'value');
    assert.equal(result.row.metadata.built_by, undefined);
    assert.equal(result.row.metadata.independent_review_by, undefined);
    assert.deepEqual(events(f.db, item.id).slice(0, -1), before);
    assert.equal(events(f.db, item.id).at(-1).event_id, result.event.event_id);
    assert.equal(reopen(f.db, item.id).reason, 'already_open');
    assert.equal(reopen(f.db, 'missing').reason, 'not_found');
  });

  test('event failure rolls back row and reset without disturbing history', t => {
    const f = fixture(t), item = setup(f), before = tasks.getTask(f.db, item.id), history = events(f.db, item.id);
    f.db.exec("CREATE TRIGGER fixture_reject_reopen BEFORE INSERT ON task_events WHEN NEW.event_type = 'reopened' BEGIN SELECT RAISE(ABORT, 'fixture reject'); END");
    assert.throws(() => reopen(f.db, item.id), /fixture reject/);
    assert.deepEqual(tasks.getTask(f.db, item.id), before);
    assert.deepEqual(events(f.db, item.id), history);
    f.db.exec('BEGIN IMMEDIATE'); f.db.exec('ROLLBACK');
  });

  test('nested transaction is rejected without rolling back the caller', t => {
    const f = fixture(t), item = setup(f);
    f.db.exec('BEGIN IMMEDIATE');
    f.db.prepare('UPDATE tasks SET title = ? WHERE id = ?').run('caller edit', item.id);
    assert.throws(() => reopen(f.db, item.id), /transaction/i);
    assert.equal(tasks.getTask(f.db, item.id).title, 'caller edit');
    assert.equal(tasks.getTask(f.db, item.id).status, 'done');
    f.db.exec('ROLLBACK');
    assert.equal(tasks.getTask(f.db, item.id).title, 'Fixture');
  });

  test('failed commit reports uncertainty both before and after SQLite commits', t => {
    const f = fixture(t);
    for (const commitFirst of [false, true]) {
      const item = setup(f), history = events(f.db, item.id);
      const wrapped = { prepare: sql => f.db.prepare(sql), exec(sql) {
        if (sql === 'COMMIT') { if (commitFirst) f.db.exec(sql); throw new Error('fixture commit error'); }
        return f.db.exec(sql);
      } };
      assert.throws(() => reopen(wrapped, item.id), error => {
        assert.equal(error.code, 'TASK_REOPEN_COMMIT_UNCERTAIN');
        assert.equal(error.taskId, item.id);
        assert.match(error.message, /outcome is unknown.*Check the task history before retrying/);
        return true;
      });
      assert.equal(tasks.getTask(f.db, item.id).status, commitFirst ? 'open' : 'done');
      assert.equal(events(f.db, item.id).length, history.length + (commitFirst ? 1 : 0));
      f.db.exec('BEGIN IMMEDIATE'); f.db.exec('ROLLBACK');
    }
  });

  test('concurrent WAL reopens produce one winner and one event', { timeout: 30000 }, async t => {
    const f = fixture(t), item = setup(f), history = events(f.db, item.id);
    assert.equal(f.db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
    const workers = Array.from({ length: 6 }, () => launch(t, f, item));
    await Promise.all(workers.map(async worker => assert.equal(await worker.next(), 'ready')));
    workers.forEach(worker => worker.child.send('go'));
    const messages = await Promise.all(workers.map(worker => worker.next()));
    const exits = await Promise.all(workers.map(worker => worker.exited));
    for (const exit of exits) assert.equal(exit.code, 0, exit.stderr);
    assert.equal(messages.filter(message => message.result?.reopened).length, 1);
    assert.equal(messages.filter(message => message.result?.reason === 'already_open').length, 5);
    const current = events(f.db, item.id);
    assert.deepEqual(current.slice(0, history.length), history);
    assert.equal(current.length, history.length + 1);
    assert.equal(current.at(-1).event_type, 'reopened');
  });

  test('process death between row update and event rolls back both', { timeout: 30000 }, async t => {
    const f = fixture(t), item = setup(f), before = tasks.getTask(f.db, item.id), history = events(f.db, item.id);
    const worker = launch(t, f, item, 'event');
    assert.equal(await worker.next(), 'ready');
    worker.child.send('go');
    assert.equal(await worker.next(), 'before-event');
    worker.child.kill('SIGKILL');
    await worker.exited;
    assert.deepEqual(tasks.getTask(f.db, item.id), before);
    assert.deepEqual(events(f.db, item.id), history);
  });
}
