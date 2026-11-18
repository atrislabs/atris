'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');
const tasks = require('../lib/task-db');

if (process.env.ATRIS_RELEASE_FIXTURE_WORKER === '1') {
  const db = tasks.open(process.env.ATRIS_RELEASE_FIXTURE_DB);
  process.send('ready');
  process.on('message', message => {
    if (message !== 'go') return;
    let connection = db;
    if (process.env.ATRIS_RELEASE_FIXTURE_PAUSE === 'event') {
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
      const id = process.env.ATRIS_RELEASE_FIXTURE_TASK;
      const actor = process.env.ATRIS_RELEASE_FIXTURE_ACTOR;
      const result = process.env.ATRIS_RELEASE_FIXTURE_OP === 'claim'
        ? tasks.claimTask(connection, { id, claimedBy: actor })
        : tasks.releaseTask(connection, { id, actor });
      process.send({ result }, () => process.exit(0));
    } catch (error) {
      process.send({ error: String(error.message) }, () => process.exit(1));
    }
  });
} else {
  function fixture(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-release-atomic-'));
    const file = path.join(dir, 'tasks.db');
    const ws = path.join(dir, 'workspace');
    const db = tasks.open(file);
    t.after(() => { tasks.close(); fs.rmSync(dir, { recursive: true, force: true }); });
    const task = tasks.addTask(db, { title: 'Fixture', workspaceRoot: ws, metadata: { keep: 'value' } });
    return { dir, file, ws, db, task };
  }
  const claim = (db, id, actor = 'worker') => tasks.claimTask(db, { id, claimedBy: actor });
  const release = (db, id, actor = 'worker') => tasks.releaseTask(db, { id, actor });
  function events(db, id) {
    return db.prepare('SELECT event_type, actor, payload FROM task_events WHERE task_id = ? ORDER BY version').all(id)
      .map(e => ({ ...e, payload: JSON.parse(e.payload) }));
  }
  function launch(t, { file, task, actor = 'worker', op = 'release', pause = '' }) {
    const child = fork(__filename, [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: {
      ...process.env, NODE_NO_WARNINGS: '1', ATRIS_RELEASE_FIXTURE_WORKER: '1', ATRIS_RELEASE_FIXTURE_DB: file,
      ATRIS_RELEASE_FIXTURE_TASK: task.id, ATRIS_RELEASE_FIXTURE_ACTOR: actor, ATRIS_RELEASE_FIXTURE_OP: op,
      ATRIS_RELEASE_FIXTURE_PAUSE: pause,
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

  test('release preserves result, event, actor and status contracts', t => {
    const { db, task } = fixture(t);
    assert.deepEqual(release(db, 'missing'), { released: false, reason: 'not_found' });
    assert.deepEqual(release(db, task.id), { released: false, reason: 'already_open', claimed_by: null });
    assert.equal(claim(db, task.id).claimed, true);
    assert.deepEqual(release(db, task.id, 'other'), { released: false, reason: 'held_by_other', claimed_by: 'worker' });
    const previousMetadata = tasks.getTask(db, task.id).metadata;
    const result = release(db, task.id);
    assert.equal(result.released, true);
    assert.equal(result.row.status, 'open');
    assert.equal(result.row.claimed_by, null);
    assert.equal(result.row.claimed_at, null);
    assert.deepEqual(result.row.metadata, previousMetadata);
    assert.equal(result.event.event_type, 'claim_released');
    assert.equal(result.event.actor, 'worker');
    assert.deepEqual(result.event.payload, { released_by: 'worker', previous_claimed_by: 'worker' });
    assert.deepEqual(events(db, task.id).map(e => e.event_type), ['created', 'claimed', 'claim_released']);
    assert.deepEqual(events(db, task.id).at(-1).payload, result.event.payload);
    assert.deepEqual(release(db, task.id), { released: false, reason: 'already_open', claimed_by: null });
    db.exec('BEGIN IMMEDIATE'); db.exec('ROLLBACK');
  });

  test('event failure rolls back release and does not retain a lock', t => {
    const { db, task } = fixture(t);
    claim(db, task.id);
    const before = tasks.getTask(db, task.id);
    db.exec("CREATE TRIGGER reject_release BEFORE INSERT ON task_events WHEN NEW.event_type = 'claim_released' BEGIN SELECT RAISE(ABORT, 'fixture reject'); END");
    assert.throws(() => release(db, task.id), /fixture reject/);
    assert.deepEqual(tasks.getTask(db, task.id), before);
    assert.deepEqual(events(db, task.id).map(e => e.event_type), ['created', 'claimed']);
    db.exec('BEGIN IMMEDIATE'); db.exec('ROLLBACK');
  });

  test('nested call fails without disturbing the caller transaction', t => {
    const { db, task } = fixture(t);
    claim(db, task.id);
    db.exec('BEGIN IMMEDIATE');
    db.prepare('UPDATE tasks SET title = ? WHERE id = ?').run('caller edit', task.id);
    assert.throws(() => release(db, task.id), /transaction/i);
    assert.equal(tasks.getTask(db, task.id).title, 'caller edit');
    assert.equal(tasks.getTask(db, task.id).status, 'claimed');
    assert.equal(events(db, task.id).length, 2);
    db.exec('ROLLBACK');
    assert.equal(tasks.getTask(db, task.id).title, 'Fixture');
  });

  test('commit failure reports uncertainty both before and after actual commit', t => {
    const { db, ws } = fixture(t);
    for (const commitFirst of [false, true]) {
      const task = tasks.addTask(db, { title: 'Commit fixture', workspaceRoot: ws });
      claim(db, task.id);
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
      assert.throws(() => release(wrapped, task.id), error => {
        assert.equal(error.code, 'TASK_RELEASE_COMMIT_UNCERTAIN');
        assert.equal(error.taskId, task.id);
        assert.match(error.message, /outcome is unknown.*Check the task history before retrying/);
        assert.match(error.cause.message, /fixture commit error/);
        return true;
      });
      assert.equal(tasks.getTask(db, task.id).status, commitFirst ? 'open' : 'claimed');
      assert.equal(events(db, task.id).filter(e => e.event_type === 'claim_released').length, commitFirst ? 1 : 0);
      db.exec('BEGIN IMMEDIATE'); db.exec('ROLLBACK');
    }
  });

  test('eight concurrent releases have one winner and one matching event', { timeout: 30000 }, async t => {
    const { db, file, task } = fixture(t);
    claim(db, task.id);
    assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
    const workers = Array.from({ length: 8 }, () => launch(t, { file, task }));
    await Promise.all(workers.map(async w => assert.equal(await w.next(), 'ready')));
    workers.forEach(w => w.child.send('go'));
    const messages = await Promise.all(workers.map(w => w.next()));
    const exits = await Promise.all(workers.map(w => w.exited));
    for (const exit of exits) assert.equal(exit.code, 0, exit.stderr);
    assert.equal(messages.filter(m => m.result?.released).length, 1);
    assert.equal(messages.filter(m => m.result?.reason === 'already_open').length, 7);
    assert.equal(tasks.getTask(db, task.id).status, 'open');
    assert.deepEqual(events(db, task.id).map(e => e.event_type), ['created', 'claimed', 'claim_released']);
  });

  test('concurrent release and claim produce only valid ordered history', { timeout: 30000 }, async t => {
    const { db, file, task } = fixture(t);
    claim(db, task.id);
    const workers = [launch(t, { file, task }), launch(t, { file, task, actor: 'other', op: 'claim' })];
    await Promise.all(workers.map(async w => assert.equal(await w.next(), 'ready')));
    workers.forEach(w => w.child.send('go'));
    const [released, claimed] = await Promise.all(workers.map(w => w.next()));
    const exits = await Promise.all(workers.map(w => w.exited));
    for (const exit of exits) assert.equal(exit.code, 0, exit.stderr);
    assert.equal(released.result.released, true);
    const history = events(db, task.id).map(e => e.event_type);
    if (claimed.result.claimed) {
      assert.deepEqual(history, ['created', 'claimed', 'claim_released', 'claimed']);
      assert.equal(tasks.getTask(db, task.id).claimed_by, 'other');
    } else {
      assert.equal(claimed.result.reason, 'already_claimed');
      assert.deepEqual(history, ['created', 'claimed', 'claim_released']);
      assert.equal(tasks.getTask(db, task.id).status, 'open');
    }
  });

  test('process death after row change before event rolls both back', { timeout: 30000 }, async t => {
    const { db, file, task } = fixture(t);
    claim(db, task.id);
    const before = tasks.getTask(db, task.id);
    const worker = launch(t, { file, task, pause: 'event' });
    assert.equal(await worker.next(), 'ready');
    worker.child.send('go');
    assert.equal(await worker.next(), 'before-event');
    worker.child.kill('SIGKILL');
    assert.equal((await worker.exited).signal, 'SIGKILL');
    assert.deepEqual(tasks.getTask(db, task.id), before);
    assert.deepEqual(events(db, task.id).map(e => e.event_type), ['created', 'claimed']);
    db.exec('BEGIN IMMEDIATE'); db.exec('ROLLBACK');
  });
}
