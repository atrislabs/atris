'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const tasks = require('../lib/task-db');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-event-numbering-'));
  const file = path.join(dir, 'tasks.db');
  const db = tasks.open(file);
  t.after(() => { tasks.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { db, file, ws: path.join(dir, 'workspace') };
}

function append(db, ws, taskId, payload = { message: 'test' }) {
  return tasks.appendTaskEvent(db, { taskId, workspaceRoot: ws, actor: 'fixture', eventType: 'message', payload });
}

test('existing duplicate history and other tasks do not change the next task version', t => {
  const { db, ws } = fixture(t);
  const insert = db.prepare('INSERT INTO task_events VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  insert.run('old-a', 'one', 2, ws, null, 'message', null, 1);
  insert.run('old-b', 'one', 2, ws, null, 'message', null, 2);
  insert.run('old-c', 'two', 50, ws, null, 'message', null, 3);
  const payload = { note: 'visible', nested: { value: 2 } };
  const event = append(db, ws, 'one', payload);
  assert.equal(event.version, 3);
  assert.deepEqual({ ...event, event_id: 'id', created_at: 1 }, {
    event_id: 'id', task_id: 'one', version: 3, workspace_root: ws,
    actor: 'fixture', event_type: 'message', payload, created_at: 1,
  });
  const saved = db.prepare('SELECT * FROM task_events WHERE event_id = ?').get(event.event_id);
  assert.equal(saved.version, event.version);
  assert.equal(saved.created_at, event.created_at);
  assert.deepEqual(JSON.parse(saved.payload), payload);
  assert.equal(append(db, ws, 'two').version, 51);
  assert.equal(append(db, ws, 'new').version, 1);
  insert.run('old-fraction', 'fraction', 1.5, ws, null, 'message', null, 1);
  assert.equal(append(db, ws, 'fraction').version, 2.5);
});

test('caller transaction rollback removes the event and preserves its reusable version', t => {
  const { db, ws } = fixture(t);
  assert.equal(append(db, ws, 'one').version, 1);
  db.exec('BEGIN IMMEDIATE');
  assert.equal(append(db, ws, 'one').version, 2);
  db.exec('ROLLBACK');
  assert.equal(db.prepare('SELECT count(*) AS n FROM task_events WHERE task_id = ?').get('one').n, 1);
  assert.equal(append(db, ws, 'one').version, 2);
  db.exec("CREATE TRIGGER reject_event BEFORE INSERT ON task_events BEGIN SELECT RAISE(ABORT, 'fixture rejection'); END");
  assert.throws(() => append(db, ws, 'one'), /fixture rejection/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM task_events WHERE task_id = ?').get('one').n, 2);
});

test('version overflow or invalid history fails before inserting an event', t => {
  const { db, ws } = fixture(t);
  const insert = db.prepare('INSERT INTO task_events VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  insert.run('old-safe', 'safe', 9007199254740990, ws, null, 'message', null, 1);
  assert.equal(append(db, ws, 'safe').version, Number.MAX_SAFE_INTEGER);
  assert.throws(() => append(db, ws, 'safe'), /not a safe integer/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM task_events WHERE task_id = ?').get('safe').n, 2);
  insert.run('old-unsafe', 'unsafe', 9007199254740992n, ws, null, 'message', null, 1);
  assert.throws(() => append(db, ws, 'unsafe'), /not a safe integer/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM task_events WHERE task_id = ?').get('unsafe').n, 1);
  insert.run('old-text', 'invalid', 'not-a-number', ws, null, 'message', null, 1);
  assert.throws(() => append(db, ws, 'invalid'), /not a safe integer/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM task_events WHERE task_id = ?').get('invalid').n, 1);
});

test('a wrapped connection retries a busy insert and propagates non-busy failures', t => {
  const { db, ws } = fixture(t);
  let prepares = 0, attempts = 0;
  const wrapped = { prepare(sql) {
    prepares++;
    const statement = db.prepare(sql);
    return { get(...args) {
      attempts++;
      if (attempts === 1) throw Object.assign(new Error('fixture busy'), { code: 'SQLITE_BUSY' });
      return statement.get(...args);
    } };
  } };
  assert.equal(append(wrapped, ws, 'one').version, 1);
  assert.equal(prepares, 2);
  assert.equal(attempts, 2);
  const failing = { prepare() { throw new Error('fixture prepare failed'); } };
  assert.throws(() => append(failing, ws, 'one'), /fixture prepare failed/);
});

function worker(file, ws, index) {
  const script = `
    const tasks = require(process.argv[1]);
    const db = tasks.open(process.argv[2]);
    const ws = process.argv[3], index = Number(process.argv[4]);
    process.stdout.write('ready\\n');
    process.stdin.once('data', () => {
      const events = [];
      for (let i = 0; i < 30; i++) events.push(tasks.appendTaskEvent(db, {
        taskId: i % 2 ? 'one' : 'two', workspaceRoot: ws, actor: 'worker-' + index,
        eventType: 'message', payload: { index, i }
      }));
      process.stdout.write(JSON.stringify(events) + '\\n');
      tasks.close();
    });`;
  const child = spawn(process.execPath, ['-e', script, require.resolve('../lib/task-db'), file, ws, String(index)], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, NODE_NO_WARNINGS: '1' } });
  let buffer = '', stderr = '', readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const completed = new Promise((resolve, reject) => {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      buffer += chunk;
      if (buffer.startsWith('ready\n')) readyResolve();
    });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => { readyReject(error); reject(error); });
    child.on('close', code => {
      if (code !== 0) { const error = new Error(stderr || `worker exited ${code}`); readyReject(error); reject(error); return; }
      try { resolve(JSON.parse(buffer.slice('ready\n'.length))); } catch (error) { reject(error); }
    });
  });
  return { child, ready, completed };
}

test('separate SQLite WAL processes return unique ordered versions for each task', { timeout: 30000 }, async t => {
  const { db, file, ws } = fixture(t);
  assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  const workers = Array.from({ length: 8 }, (_, index) => worker(file, ws, index));
  t.after(() => { for (const { child } of workers) if (child.exitCode === null) child.kill(); });
  await Promise.all(workers.map(w => w.ready));
  for (const { child } of workers) child.stdin.end('go');
  const events = (await Promise.all(workers.map(w => w.completed))).flat();
  assert.equal(events.length, 240);
  for (const taskId of ['one', 'two']) {
    const returned = events.filter(event => event.task_id === taskId).map(event => event.version).sort((a, b) => a - b);
    assert.deepEqual(returned, Array.from({ length: 120 }, (_, index) => index + 1));
    const stored = db.prepare('SELECT event_id, version FROM task_events WHERE task_id = ? ORDER BY version').all(taskId);
    assert.deepEqual(stored.map(row => row.version), returned);
    const ids = new Set(stored.map(row => row.event_id));
    assert.equal(ids.size, 120);
    assert.ok(events.filter(event => event.task_id === taskId).every(event => ids.has(event.event_id)));
  }
});
