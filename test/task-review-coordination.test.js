'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');
const tasks = require('../lib/task-db');

const operations = {
  ready: (db, id) => tasks.readyTask(db, { id, actor: 'worker', proof: 'Synthetic proof' }),
  result: (db, id) => tasks.setTaskResult(db, { id, actor: 'worker', result: 'Synthetic result' }),
  review: (db, id) => tasks.reviewTask(db, { id, actor: 'reviewer', reward: 0, proof: 'Reviewed' }),
  completion: (db, id) => tasks.doneTask(db, { id, actor: 'reviewer', allowReview: true }),
};
const eventTypes = { ready: 'proof_ready', result: 'result_set', review: 'reviewed', completion: 'completed' };

if (process.env.ATRIS_REVIEW_COORD_WORKER) {
  const db = tasks.open(process.env.ATRIS_REVIEW_COORD_DB);
  const connection = {
    exec(sql) {
      if (sql === 'BEGIN IMMEDIATE' && process.env.ATRIS_REVIEW_COORD_PAUSE === 'begin') fs.writeFileSync(process.env.ATRIS_REVIEW_COORD_GATE, 'attempting');
      if (sql === 'COMMIT' && process.env.ATRIS_REVIEW_COORD_PAUSE === 'commit') {
        process.send('before-commit');
        while (!fs.existsSync(process.env.ATRIS_REVIEW_COORD_GATE)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
      return db.exec(sql);
    },
    prepare(sql) {
      if (sql.includes('INSERT INTO task_events') && process.env.ATRIS_REVIEW_COORD_PAUSE === 'event') {
        process.send('before-event');
        while (!fs.existsSync(process.env.ATRIS_REVIEW_COORD_GATE)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
      return db.prepare(sql);
    },
  };
  process.send('ready');
  process.on('message', msg => {
    if (msg !== 'go') return;
    try {
      const id = process.env.ATRIS_REVIEW_COORD_ID;
      const name = process.env.ATRIS_REVIEW_COORD_WORKER;
      const result = name === 'revision'
        ? tasks.reviseTask(connection, { id, actor: 'human', note: 'Revision required' })
        : operations[name](connection, id);
      process.send({ result }, () => process.exit(0));
    } catch (error) { process.send({ error: error.message }, () => process.exit(1)); }
  });
} else {
  function fixture(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-review-coordination-'));
    const file = path.join(dir, 'tasks.db');
    const ws = path.join(dir, 'workspace');
    fs.mkdirSync(ws);
    const db = tasks.open(file);
    const row = tasks.addTask(db, { title: 'Synthetic task', workspaceRoot: ws, status: 'review', metadata: { approval_status: 'pending', prior: 'keep' } });
    t.after(() => { tasks.close(); fs.rmSync(dir, { recursive: true, force: true }); });
    return { dir, file, ws, db, id: row.id };
  }
  function launch(t, f, op, pause = '') {
    const gate = path.join(f.dir, `${op}-${Math.random()}.gate`);
    const child = fork(__filename, [], { env: { ...process.env, NODE_NO_WARNINGS: '1', ATRIS_REVIEW_COORD_WORKER: op, ATRIS_REVIEW_COORD_DB: f.file, ATRIS_REVIEW_COORD_ID: f.id, ATRIS_REVIEW_COORD_PAUSE: pause, ATRIS_REVIEW_COORD_GATE: gate }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let stderr = ''; child.stderr.on('data', c => { stderr += c; });
    const queue = [], waiting = [];
    child.on('message', m => waiting.length ? waiting.shift()(m) : queue.push(m));
    const next = () => queue.length ? Promise.resolve(queue.shift()) : new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`worker timed out: ${stderr}`)), 12000);
      waiting.push(m => { clearTimeout(timer); resolve(m); });
    });
    const exited = new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal, stderr })));
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
    return { child, next, gate, exited };
  }
  function events(db, id, name) {
    return db.prepare('SELECT * FROM task_events WHERE task_id = ? AND event_type = ?').all(id, name);
  }
  for (const name of Object.keys(operations)) {
    test(`${name} rolls back the task when its event fails`, t => {
      const f = fixture(t); const before = tasks.getTask(f.db, f.id);
      f.db.exec(`CREATE TRIGGER fixture_reject BEFORE INSERT ON task_events WHEN NEW.event_type = '${eventTypes[name]}' BEGIN SELECT RAISE(ABORT, 'fixture event failure'); END`);
      assert.throws(() => operations[name](f.db, f.id), /fixture event failure/);
      assert.deepEqual(tasks.getTask(f.db, f.id), before);
      assert.equal(events(f.db, f.id, eventTypes[name]).length, 0);
    });
    test(`${name} rejects caller-owned transaction without rolling it back`, t => {
      const f = fixture(t); f.db.exec('BEGIN IMMEDIATE');
      f.db.prepare('UPDATE tasks SET title = ? WHERE id = ?').run('Caller edit', f.id);
      assert.throws(() => operations[name](f.db, f.id), /transaction/i);
      assert.equal(tasks.getTask(f.db, f.id).title, 'Caller edit');
      f.db.exec('ROLLBACK');
      assert.equal(tasks.getTask(f.db, f.id).title, 'Synthetic task');
    });
    for (const committed of [false, true]) test(`${name} reports unknown commit ${committed ? 'after' : 'before'} SQLite commits`, t => {
      const f = fixture(t);
      const db = { prepare: sql => f.db.prepare(sql), exec(sql) {
        if (sql === 'COMMIT') { if (committed) f.db.exec(sql); throw new Error('fixture commit failure'); }
        return f.db.exec(sql);
      } };
      assert.throws(() => operations[name](db, f.id), e => e.code === `TASK_${name.toUpperCase()}_COMMIT_UNCERTAIN` && e.taskId === f.id && /unknown.*history before retrying/.test(e.message));
      assert.equal(events(f.db, f.id, eventTypes[name]).length, committed ? 1 : 0);
    });
    for (const pause of ['event', 'commit']) test(`${name} loses both row and event when killed before ${pause}`, async t => {
      const f = fixture(t); const before = tasks.getTask(f.db, f.id); const child = launch(t, f, name, pause);
      assert.equal(await child.next(), 'ready'); child.child.send('go'); assert.equal(await child.next(), `before-${pause}`);
      child.child.kill('SIGKILL'); await child.exited;
      assert.deepEqual(tasks.getTask(f.db, f.id), before); assert.equal(events(f.db, f.id, eventTypes[name]).length, 0);
    });
    test(`${name} reads after a revision which already owns the write lock`, async t => {
      const f = fixture(t); const first = launch(t, f, 'revision', 'event'); const second = launch(t, f, name, 'begin');
      assert.equal(await first.next(), 'ready'); assert.equal(await second.next(), 'ready');
      first.child.send('go'); assert.equal(await first.next(), 'before-event');
      second.child.send('go');
      const deadline = Date.now() + 10000;
      while (!fs.existsSync(second.gate)) { if (Date.now() > deadline) throw new Error('second writer did not attempt transaction'); await new Promise(resolve => setTimeout(resolve, 5)); }
      fs.writeFileSync(first.gate, 'go');
      const [a, b] = await Promise.all([first.next(), second.next()]);
      assert.equal(a.result?.revised, true, JSON.stringify(a)); assert.ok(b.result, JSON.stringify(b));
      const final = tasks.getTask(f.db, f.id);
      assert.equal(final.metadata.human_revision_note, 'Revision required');
      assert.equal(events(f.db, f.id, eventTypes[name]).length, 1);
    });
    test(`${name} and a simultaneous revision serialize as actual WAL writers`, async t => {
      const f = fixture(t); const first = launch(t, f, name, 'event'); const second = launch(t, f, 'revision', 'begin');
      assert.equal(await first.next(), 'ready'); assert.equal(await second.next(), 'ready');
      first.child.send('go'); assert.equal(await first.next(), 'before-event');
      second.child.send('go');
      const deadline = Date.now() + 10000;
      while (!fs.existsSync(second.gate)) { if (Date.now() > deadline) throw new Error('second writer did not attempt transaction'); await new Promise(resolve => setTimeout(resolve, 5)); }
      fs.writeFileSync(first.gate, 'go');
      const [a, b] = await Promise.all([first.next(), second.next()]);
      assert.ok(a.result, JSON.stringify(a)); assert.ok(b.result, JSON.stringify(b));
      assert.equal(events(f.db, f.id, eventTypes[name]).length, 1);
      const final = tasks.getTask(f.db, f.id);
      if (name === 'completion') { assert.equal(b.result.revised, false); assert.equal(final.status, 'done'); }
      else { assert.equal(b.result.revised, true); assert.equal(final.metadata.human_revision_note, 'Revision required'); assert.equal(final.status, 'open'); }
    });
  }
  test('review episode failure reports a committed review and its event', t => {
    const f = fixture(t); const ws = path.join(f.dir, 'not-dir'); fs.writeFileSync(ws, 'x');
    f.db.prepare('UPDATE tasks SET workspace_root = ? WHERE id = ?').run(ws, f.id);
    assert.throws(() => operations.review(f.db, f.id), e => e.code === 'TASK_REVIEW_EPISODE_UNCERTAIN' && e.reviewCommitted && Boolean(e.eventId) && Boolean(e.cause));
    assert.equal(events(f.db, f.id, 'reviewed').length, 1);
  });
  for (const name of ['review', 'completion']) test(`${name} writes files after releasing the database lock`, t => {
    const f = fixture(t); fs.mkdirSync(path.join(f.ws, 'atris'));
    const { DatabaseSync } = require('node:sqlite'); const other = new DatabaseSync(f.file);
    const original = fs.appendFileSync; let checked = false;
    fs.appendFileSync = function (...args) {
      other.exec('BEGIN IMMEDIATE'); other.exec('ROLLBACK'); checked = true;
      return original.apply(this, args);
    };
    try { operations[name](f.db, f.id); assert.equal(checked, true); }
    finally { fs.appendFileSync = original; other.close(); }
  });
  test('completion log failure reports a committed completion and its event', t => {
    const f = fixture(t); fs.mkdirSync(path.join(f.ws, 'atris')); fs.writeFileSync(path.join(f.ws, 'atris', 'logs'), 'not a directory');
    assert.throws(() => operations.completion(f.db, f.id), e => e.code === 'TASK_COMPLETION_LOG_UNCERTAIN' && e.completionCommitted && Boolean(e.eventId) && Boolean(e.cause));
    assert.equal(tasks.getTask(f.db, f.id).status, 'done'); assert.equal(events(f.db, f.id, 'completed').length, 1);
  });
}
