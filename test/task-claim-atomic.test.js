'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');
const tasks = require('../lib/task-db');

if (process.env.ATRIS_CLAIM_FIXTURE_WORKER === '1') {
  const db = tasks.open(process.env.ATRIS_CLAIM_FIXTURE_DB);
  process.send('ready');
  process.on('message', message => {
    if (message !== 'go') return;
    let connection = db;
    if (process.env.ATRIS_CLAIM_FIXTURE_PAUSE === 'event') {
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
      const result = tasks.claimTask(connection, { id: process.env.ATRIS_CLAIM_FIXTURE_TASK, claimedBy: process.env.ATRIS_CLAIM_FIXTURE_ACTOR });
      process.send({ result }, () => process.exit(0));
    } catch (error) {
      process.send({ error: String(error.message) }, () => process.exit(1));
    }
  });
} else {
  function fixture(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-claim-atomic-'));
    const file = path.join(dir, 'tasks.db');
    const ws = path.join(dir, 'workspace');
    const db = tasks.open(file);
    t.after(() => { tasks.close(); fs.rmSync(dir, { recursive: true, force: true }); });
    return { dir, file, ws, db };
  }
  function setup(db, ws, extra = {}) {
    return tasks.addTask(db, { title: 'Fixture', workspaceRoot: ws, ...extra });
  }
  function claim(db, id, claimedBy = 'fixture-worker') {
    return tasks.claimTask(db, { id, claimedBy });
  }
  function events(db, id) {
    return db.prepare("SELECT actor, payload FROM task_events WHERE task_id = ? AND event_type = 'claimed'").all(id);
  }
  function launch(t, { file, task, actor = 'fixture-worker', pause = '' }) {
    const child = fork(__filename, [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: {
      ...process.env, NODE_NO_WARNINGS: '1', ATRIS_CLAIM_FIXTURE_WORKER: '1', ATRIS_CLAIM_FIXTURE_DB: file,
      ATRIS_CLAIM_FIXTURE_TASK: task.id, ATRIS_CLAIM_FIXTURE_ACTOR: actor, ATRIS_CLAIM_FIXTURE_PAUSE: pause,
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

  test('claim returns the saved row and event, and preserves no-op reasons', t => {
    const { db, ws } = fixture(t);
    const task = setup(db, ws, { metadata: { keep: 'value' } });
    const result = claim(db, task.id);
    assert.equal(result.claimed, true);
    assert.equal(result.row.status, 'claimed');
    assert.equal(result.row.claimed_by, 'fixture-worker');
    assert.equal(result.row.metadata.keep, 'value');
    assert.deepEqual(events(db, task.id).map(e => [e.actor, JSON.parse(e.payload)]), [['fixture-worker', { claimed_by: 'fixture-worker' }]]);
    assert.deepEqual(claim(db, task.id, 'other'), { claimed: false, reason: 'already_claimed', claimed_by: 'fixture-worker' });
    assert.deepEqual(claim(db, 'missing'), { claimed: false, reason: 'not_found' });
    db.exec('BEGIN IMMEDIATE'); db.exec('ROLLBACK');
  });

  test('event insert failure rolls back the row and releases the lock', t => {
    const { db, ws } = fixture(t);
    const task = setup(db, ws);
    const before = tasks.getTask(db, task.id);
    db.exec("CREATE TRIGGER fixture_reject_claim BEFORE INSERT ON task_events WHEN NEW.event_type = 'claimed' BEGIN SELECT RAISE(ABORT, 'fixture reject'); END");
    assert.throws(() => claim(db, task.id), /fixture reject/);
    assert.deepEqual(tasks.getTask(db, task.id), before);
    assert.equal(events(db, task.id).length, 0);
    db.exec('BEGIN IMMEDIATE'); db.exec('ROLLBACK');
  });

  test('nested call rejects without touching the caller transaction', t => {
    const { db, ws } = fixture(t);
    const task = setup(db, ws);
    db.exec('BEGIN IMMEDIATE');
    db.prepare('UPDATE tasks SET title = ? WHERE id = ?').run('caller edit', task.id);
    assert.throws(() => claim(db, task.id), /transaction/i);
    assert.equal(tasks.getTask(db, task.id).title, 'caller edit');
    assert.equal(tasks.getTask(db, task.id).status, 'open');
    assert.equal(events(db, task.id).length, 0);
    db.exec('ROLLBACK');
    assert.equal(tasks.getTask(db, task.id).title, 'Fixture');
  });

  test('commit errors report uncertainty whether the commit did or did not happen', t => {
    const { db, ws } = fixture(t);
    for (const commitFirst of [false, true]) {
      const task = setup(db, ws);
      const wrapped = {
        prepare: sql => db.prepare(sql),
        exec(sql) {
          if (sql === 'COMMIT') {
            if (commitFirst) db.exec(sql);
            throw new Error('fixture commit error');
          }
          return db.exec(sql);
        },
      };
      assert.throws(() => claim(wrapped, task.id), error => {
        assert.equal(error.code, 'TASK_CLAIM_COMMIT_UNCERTAIN');
        assert.equal(error.taskId, task.id);
        assert.match(error.message, /outcome is unknown.*Check the task history before retrying/);
        assert.match(error.cause.message, /fixture commit error/);
        return true;
      });
      assert.equal(tasks.getTask(db, task.id).status, commitFirst ? 'claimed' : 'open');
      assert.equal(events(db, task.id).length, commitFirst ? 1 : 0);
      db.exec('BEGIN IMMEDIATE'); db.exec('ROLLBACK');
    }
  });

  test('concurrent real WAL claims have one winner and one matching event', { timeout: 30000 }, async t => {
    const { db, file, ws } = fixture(t);
    const task = setup(db, ws);
    assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
    const workers = Array.from({ length: 8 }, (_, i) => launch(t, { file, task, actor: `worker-${i}` }));
    await Promise.all(workers.map(async worker => assert.equal(await worker.next(), 'ready')));
    workers.forEach(worker => worker.child.send('go'));
    const messages = await Promise.all(workers.map(worker => worker.next()));
    const exits = await Promise.all(workers.map(worker => worker.exited));
    for (const exit of exits) assert.equal(exit.code, 0, exit.stderr);
    const winners = messages.filter(m => m.result?.claimed);
    assert.equal(winners.length, 1);
    assert.equal(messages.filter(m => m.result?.reason === 'already_claimed').length, 7);
    const actor = winners[0].result.row.claimed_by;
    assert.equal(tasks.getTask(db, task.id).claimed_by, actor);
    assert.deepEqual(events(db, task.id).map(e => [e.actor, JSON.parse(e.payload)]), [[actor, { claimed_by: actor }]]);
  });

  test('process death after row update before event rolls back both', { timeout: 30000 }, async t => {
    const { db, file, ws } = fixture(t);
    const task = setup(db, ws);
    const before = tasks.getTask(db, task.id);
    const worker = launch(t, { file, task, pause: 'event' });
    assert.equal(await worker.next(), 'ready');
    worker.child.send('go');
    assert.equal(await worker.next(), 'before-event');
    worker.child.kill('SIGKILL');
    assert.equal((await worker.exited).signal, 'SIGKILL');
    assert.deepEqual(tasks.getTask(db, task.id), before);
    assert.equal(events(db, task.id).length, 0);
    db.exec('BEGIN IMMEDIATE'); db.exec('ROLLBACK');
  });
}
