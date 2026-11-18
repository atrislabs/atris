'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');
const tasks = require('../lib/task-db');

if (process.env.ATRIS_REVISION_FIXTURE_WORKER === '1') {
  const db = tasks.open(process.env.ATRIS_REVISION_FIXTURE_DB);
  process.send('ready');
  process.on('message', message => {
    if (message !== 'go') return;
    let connection = db;
    if (process.env.ATRIS_REVISION_FIXTURE_PAUSE === 'event') {
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
      const result = tasks.reviseTask(connection, { id: process.env.ATRIS_REVISION_FIXTURE_TASK, actor: 'fixture-worker', note: 'Please revise' });
      process.send({ result }, () => process.exit(0));
    } catch (error) {
      process.send({ error: String(error.message) }, () => process.exit(1));
    }
  });
} else {
  function fixture(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-revision-atomic-'));
    const file = path.join(dir, 'tasks.db');
    const ws = path.join(dir, 'workspace');
    const db = tasks.open(file);
    t.after(() => { tasks.close(); fs.rmSync(dir, { recursive: true, force: true }); });
    return { dir, file, ws, db };
  }

  function setup(db, ws, options = {}) {
    return tasks.addTask(db, { title: 'Fixture', workspaceRoot: ws, status: 'review', ...options });
  }
  function revise(db, id, extra = {}) {
    return tasks.reviseTask(db, { id, actor: 'fixture', note: 'Please revise', ...extra });
  }
  function eventCount(db, id) {
    return db.prepare("SELECT count(*) AS n FROM task_events WHERE task_id = ? AND event_type = 'revision_requested'").get(id).n;
  }
  function launch(t, { file, task, pause }) {
    const child = fork(__filename, [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: {
      ...process.env, NODE_NO_WARNINGS: '1', ATRIS_REVISION_FIXTURE_WORKER: '1', ATRIS_REVISION_FIXTURE_DB: file,
      ATRIS_REVISION_FIXTURE_TASK: task.id, ATRIS_REVISION_FIXTURE_PAUSE: pause || '',
    } });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    const messages = [];
    const pending = [];
    child.on('message', message => { if (pending.length) pending.shift()(message); else messages.push(message); });
    const next = () => messages.length ? Promise.resolve(messages.shift()) : new Promise(resolve => pending.push(resolve));
    const exited = new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal, stderr })));
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
    return { child, next, exited };
  }

  test('normal and accepted-done revisions preserve the event and episode contract', t => {
    const { db, ws } = fixture(t);
    const task = setup(db, ws, { claimedBy: 'worker', metadata: { agent_review_pass_count: 2, keep: 'yes' } });
    const result = revise(db, task.id);
    assert.equal(result.revised, true);
    assert.equal(result.row.status, 'claimed');
    assert.equal(result.row.metadata.keep, 'yes');
    assert.equal(result.row.metadata.agent_review_pass_count, undefined);
    assert.equal(result.event.event_type, 'revision_requested');
    assert.equal(result.episode.episode_id, result.event.event_id);
    const episode = JSON.parse(fs.readFileSync(path.join(ws, '.atris/state/task_episodes.jsonl'), 'utf8').trim());
    assert.deepEqual(episode, result.episode);
    const done = tasks.addTask(db, { title: 'Done', workspaceRoot: ws, status: 'done', metadata: { approval_status: 'accepted', accepted_by: 'person' } });
    assert.equal(revise(db, done.id).reason, 'not_reviewable_done');
    const reopened = revise(db, done.id, { allowDone: true });
    assert.equal(reopened.revised, true);
    assert.equal(reopened.row.status, 'open');
    assert.equal(reopened.row.metadata.accepted_by, undefined);
    assert.equal(reopened.event.payload.previous_status, 'done');
  });

  test('event insertion failure rolls back the full row and releases the lock', t => {
    const { db, ws } = fixture(t);
    const task = setup(db, ws, { metadata: { original: 'value' } });
    const before = tasks.getTask(db, task.id);
    db.exec("CREATE TRIGGER fixture_reject_revision BEFORE INSERT ON task_events WHEN NEW.event_type = 'revision_requested' BEGIN SELECT RAISE(ABORT, 'fixture reject'); END");
    assert.throws(() => revise(db, task.id), /fixture reject/);
    assert.deepEqual(tasks.getTask(db, task.id), before);
    assert.equal(eventCount(db, task.id), 0);
    assert.equal(fs.existsSync(path.join(ws, '.atris/state/task_episodes.jsonl')), false);
    db.exec('BEGIN IMMEDIATE'); db.exec('ROLLBACK');
  });

  test('caller transactions are rejected without rolling back caller changes or writing episode', t => {
    const { db, ws } = fixture(t);
    const task = setup(db, ws);
    db.exec('BEGIN IMMEDIATE');
    db.prepare('UPDATE tasks SET title = ? WHERE id = ?').run('caller edit', task.id);
    assert.throws(() => revise(db, task.id), /transaction/i);
    assert.equal(tasks.getTask(db, task.id).title, 'caller edit');
    assert.equal(eventCount(db, task.id), 0);
    assert.equal(fs.existsSync(path.join(ws, '.atris/state/task_episodes.jsonl')), false);
    db.exec('ROLLBACK');
    assert.equal(tasks.getTask(db, task.id).title, 'Fixture');
  });

  test('episode failure reports committed revision and uncertain episode', t => {
    const { db, dir } = fixture(t);
    const ws = path.join(dir, 'not-a-directory');
    fs.writeFileSync(ws, 'fixture');
    const task = setup(db, ws);
    assert.throws(() => revise(db, task.id), error => {
      assert.equal(error.code, 'TASK_REVISION_EPISODE_UNCERTAIN');
      assert.equal(error.revisionCommitted, true);
      assert.equal(error.taskId, task.id);
      assert.ok(error.eventId);
      assert.match(error.message, /committed.*missing or may be incomplete.*Do not retry/);
      assert.ok(error.cause);
      return true;
    });
    assert.equal(tasks.getTask(db, task.id).status, 'open');
    assert.equal(eventCount(db, task.id), 1);
    assert.equal(revise(db, task.id).reason, 'not_reviewable_open');
  });

  test('a commit error reports an unknown outcome whether SQLite committed or rolled back', t => {
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
      assert.throws(() => revise(wrapped, task.id), error => {
        assert.equal(error.code, 'TASK_REVISION_COMMIT_UNCERTAIN');
        assert.equal(error.taskId, task.id);
        assert.match(error.message, /outcome is unknown.*Check the task history before retrying/);
        assert.match(error.cause.message, /fixture commit error/);
        return true;
      });
      assert.equal(eventCount(db, task.id), commitFirst ? 1 : 0);
      assert.equal(tasks.getTask(db, task.id).status, commitFirst ? 'open' : 'review');
      assert.equal(fs.existsSync(path.join(ws, '.atris/state/task_episodes.jsonl')), false);
      db.exec('BEGIN IMMEDIATE'); db.exec('ROLLBACK');
    }
  });

  test('missing and non-reviewable tasks release their locks', t => {
    const { db, ws } = fixture(t);
    const task = tasks.addTask(db, { title: 'Open', workspaceRoot: ws });
    assert.equal(revise(db, 'missing').reason, 'not_found');
    db.exec('BEGIN IMMEDIATE'); db.exec('ROLLBACK');
    assert.equal(revise(db, task.id).reason, 'not_reviewable_open');
    db.exec('BEGIN IMMEDIATE'); db.exec('ROLLBACK');
  });

  test('concurrent actual WAL revisions admit one winner and one event', { timeout: 30000 }, async t => {
    const { db, file, ws } = fixture(t);
    const task = setup(db, ws);
    assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
    const workers = Array.from({ length: 4 }, () => launch(t, { file, task }));
    await Promise.all(workers.map(async w => assert.equal(await w.next(), 'ready')));
    workers.forEach(w => w.child.send('go'));
    const messages = await Promise.all(workers.map(w => w.next()));
    const exits = await Promise.all(workers.map(w => w.exited));
    for (const exit of exits) assert.equal(exit.code, 0, exit.stderr);
    assert.equal(messages.filter(x => x.result?.revised).length, 1);
    assert.equal(messages.filter(x => x.result?.reason === 'not_reviewable_open').length, 3);
    assert.equal(eventCount(db, task.id), 1);
    assert.equal(fs.readFileSync(path.join(ws, '.atris/state/task_episodes.jsonl'), 'utf8').trim().split('\n').length, 1);
  });

  test('revision observes committed metadata changes made while waiting for the lock', { timeout: 30000 }, async t => {
    const { db, file, ws } = fixture(t);
    const task = setup(db, ws);
    const worker = launch(t, { file, task });
    assert.equal(await worker.next(), 'ready');
    db.exec('BEGIN IMMEDIATE');
    db.prepare('UPDATE tasks SET metadata = ? WHERE id = ?').run(JSON.stringify({ from_other_writer: 'kept' }), task.id);
    worker.child.send('go');
    await new Promise(resolve => setTimeout(resolve, 100));
    db.exec('COMMIT');
    const message = await worker.next();
    assert.equal((await worker.exited).code, 0);
    assert.equal(message.result.revised, true);
    assert.equal(message.result.row.metadata.from_other_writer, 'kept');
  });

  test('process death after row update before event rolls back the row', { timeout: 30000 }, async t => {
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
    assert.equal(eventCount(db, task.id), 0);
    assert.equal(fs.existsSync(path.join(ws, '.atris/state/task_episodes.jsonl')), false);
  });
}
