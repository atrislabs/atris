'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const tasks = require('../lib/task-db');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-task-create-'));
  const file = path.join(dir, 'tasks.db');
  const db = tasks.open(file);
  t.after(() => { tasks.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { db, file, ws: path.join(dir, 'workspace') };
}

function create(db, ws, requestId, title = 'Build the workshop') {
  return tasks.createTaskOnce(db, { title, workspaceRoot: ws, requestId });
}

function child(file, ws, requestId, title, quiet = false) {
  const script = `const tasks = require(process.argv[1]);
    const db = tasks.open(process.argv[2]);
    try { const value = tasks.createTaskOnce(db, {workspaceRoot: process.argv[3], requestId: process.argv[4], title: process.argv[5]});
      if (process.argv[6] !== 'quiet') process.stdout.write(JSON.stringify(value));
    } finally { tasks.close(); }`;
  return new Promise((resolve, reject) => {
    const process = spawn(processExec(), ['-e', script, require.resolve('../lib/task-db'), file, ws, requestId, title, quiet ? 'quiet' : 'report'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    process.stdout.on('data', chunk => { stdout += chunk; });
    process.stderr.on('data', chunk => { stderr += chunk; });
    process.on('error', reject);
    process.on('close', code => code === 0 ? resolve(stdout ? JSON.parse(stdout) : null) : reject(new Error(stderr || `child exited ${code}`)));
  });
}
function processExec() { return process.execPath; }

test('creation and replay preserve the canonical task and event', t => {
  const { db, ws } = fixture(t), requestId = randomUUID();
  const first = create(db, ws, requestId);
  assert.equal(first.inserted, true);
  assert.deepEqual(create(db, ws, requestId), { id: first.id, inserted: false });
  const rows = tasks.listTasks(db, { workspaceRoot: ws });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'open');
  assert.equal(rows[0].claimed_by, null);
  assert.equal(rows[0].metadata.verification_status, 'degraded');
  const events = tasks.listTaskEvents(db, { taskId: first.id });
  assert.equal(events.length, 1);
  assert.equal(events[0].event_type, 'created');
  assert.equal(events[0].payload.title, 'Build the workshop');
});

test('same request cannot be reused for a different title or workspace', t => {
  const { db, ws } = fixture(t), requestId = randomUUID();
  create(db, ws, requestId);
  assert.throws(() => create(db, ws, requestId, 'Another task'), /identity conflict/);
  assert.throws(() => create(db, `${ws}-other`, requestId), /identity conflict/);
  assert.equal(tasks.listTasks(db, {}).length, 1);
  assert.equal(tasks.listTasks(db, { workspaceRoot: `${ws}-other` }).length, 0);
  const separate = create(db, `${ws}-other`, randomUUID());
  assert.equal(tasks.listTasks(db, { workspaceRoot: `${ws}-other` })[0].id, separate.id);
});

test('a failed event insert rolls back the task', t => {
  const { db, ws } = fixture(t), requestId = randomUUID();
  db.exec("CREATE TRIGGER reject_create BEFORE INSERT ON task_events BEGIN SELECT RAISE(ABORT, 'event failure'); END");
  assert.throws(() => create(db, ws, requestId), /event failure/);
  assert.equal(tasks.listTasks(db, {}).length, 0);
  assert.equal(tasks.listTaskEvents(db, {}).length, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM task_creation_receipts').get().n, 0);
  db.exec('DROP TRIGGER reject_create');
  assert.equal(create(db, ws, requestId).inserted, true);
});

test('simultaneous callers create one task and reconcile a lost response', async t => {
  const { db, file, ws } = fixture(t), requestId = randomUUID();
  const values = await Promise.all(Array.from({ length: 4 }, () => child(file, ws, requestId, 'Build the workshop')));
  assert.equal(values.filter(value => value.inserted).length, 1);
  assert.equal(new Set(values.map(value => value.id)).size, 1);
  assert.equal(tasks.listTasks(db, {}).length, 1);
  assert.equal(tasks.listTaskEvents(db, {}).length, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM task_creation_receipts').get().n, 1);
  const lostId = randomUUID();
  await child(file, ws, lostId, 'Another task', true);
  const replay = create(db, ws, lostId, 'Another task');
  assert.equal(replay.inserted, false);
  assert.equal(tasks.listTaskEvents(db, { taskId: replay.id }).length, 1);
  assert.equal(tasks.listTasks(db, {}).length, 2);
});

test('concurrent conflicting requests cannot create two tasks', async t => {
  const { db, file, ws } = fixture(t), requestId = randomUUID();
  const values = await Promise.allSettled([
    child(file, ws, requestId, 'First title'),
    child(file, ws, requestId, 'Second title'),
  ]);
  assert.equal(values.filter(value => value.status === 'fulfilled').length, 1);
  assert.equal(values.filter(value => value.status === 'rejected').length, 1);
  assert.equal(tasks.listTasks(db, {}).length, 1);
  assert.equal(tasks.listTaskEvents(db, {}).length, 1);
});

test('an existing foreign or incomplete key is not accepted as a replay', t => {
  const { db, ws } = fixture(t), requestId = randomUUID();
  const key = `atris:city:task-create:v1:${requestId}`;
  const first = tasks.addTask(db, { title: 'Build the workshop', workspaceRoot: ws, sourceKey: key });
  assert.throws(() => create(db, ws, requestId), /identity conflict/);
  assert.equal(tasks.listTasks(db, {}).length, 1);
  db.prepare('DELETE FROM task_events WHERE task_id = ?').run(first.id);
  assert.throws(() => create(db, ws, requestId), /identity conflict/);
});

test('retained creation event blocks replay after deletion or a changed source key', t => {
  const { db, ws } = fixture(t);
  const deletedRequest = randomUUID();
  const deleted = create(db, ws, deletedRequest);
  db.prepare('DELETE FROM tasks WHERE id = ?').run(deleted.id);
  assert.throws(() => create(db, ws, deletedRequest), /identity conflict/);
  assert.equal(tasks.listTasks(db, {}).length, 0);
  assert.equal(tasks.listTaskEvents(db, { taskId: deleted.id }).length, 1);

  const changedRequest = randomUUID();
  const changed = create(db, ws, changedRequest);
  db.prepare('UPDATE tasks SET source_key = ? WHERE id = ?').run('different-key', changed.id);
  assert.throws(() => create(db, ws, changedRequest), /identity conflict/);
  assert.equal(tasks.listTasks(db, {}).length, 1);
  assert.equal(tasks.listTaskEvents(db, { taskId: changed.id }).length, 1);
});

test('the receipt blocks recreation even after both task and event are deleted', t => {
  const { db, ws } = fixture(t), requestId = randomUUID();
  const original = create(db, ws, requestId);
  db.prepare('DELETE FROM task_events WHERE task_id = ?').run(original.id);
  db.prepare('DELETE FROM tasks WHERE id = ?').run(original.id);
  assert.throws(() => create(db, ws, requestId), /identity conflict/);
  assert.equal(tasks.listTasks(db, {}).length, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM task_creation_receipts').get().n, 1);
  assert.throws(() => db.exec('DELETE FROM task_creation_receipts'), /immutable/);
  assert.throws(() => db.exec("UPDATE task_creation_receipts SET title = 'changed'"), /immutable/);
  assert.throws(() => db.exec('INSERT OR REPLACE INTO task_creation_receipts SELECT * FROM task_creation_receipts'), /immutable/);
});

test('a receipt insertion error rolls back task and event', t => {
  const { db, ws } = fixture(t), requestId = randomUUID();
  db.exec("CREATE TRIGGER reject_receipt BEFORE INSERT ON task_creation_receipts BEGIN SELECT RAISE(ABORT, 'receipt failure'); END");
  assert.throws(() => create(db, ws, requestId), /receipt failure/);
  assert.equal(tasks.listTasks(db, {}).length, 0);
  assert.equal(tasks.listTaskEvents(db, {}).length, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM task_creation_receipts').get().n, 0);
});

test('existing schema can be opened to add the receipt table', t => {
  const { db, file, ws } = fixture(t);
  db.exec('DROP TRIGGER task_creation_receipts_no_update');
  db.exec('DROP TRIGGER task_creation_receipts_no_replace');
  db.exec('DROP TRIGGER task_creation_receipts_no_delete');
  db.exec('DROP TABLE task_creation_receipts');
  db.exec('PRAGMA user_version = 2');
  tasks.close();
  const migrated = tasks.open(file);
  assert.equal(migrated.prepare('PRAGMA user_version').get().user_version, 3);
  assert.equal(create(migrated, ws, randomUUID()).inserted, true);
});

test('opening a newer schema does not lower its version', t => {
  const { db, file } = fixture(t);
  db.exec('PRAGMA user_version = 4');
  tasks.close();
  const reopened = tasks.open(file);
  assert.equal(reopened.prepare('PRAGMA user_version').get().user_version, 4);
});

test('a failing pre-commit guard rolls back creation and guards replay', t => {
  const { db, ws } = fixture(t), requestId = randomUUID();
  const args = { title: 'Build the workshop', workspaceRoot: ws, requestId };
  assert.throws(() => tasks.createTaskOnce(db, args, { beforeCommit() { throw new Error('Grant expired'); } }), /Grant expired/);
  assert.equal(tasks.listTasks(db, {}).length, 0);
  assert.equal(tasks.listTaskEvents(db, {}).length, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM task_creation_receipts').get().n, 0);
  const created = tasks.createTaskOnce(db, args, { beforeCommit() {} });
  assert.throws(() => tasks.createTaskOnce(db, args, { beforeCommit() { throw new Error('Grant revoked'); } }), /Grant revoked/);
  assert.deepEqual(tasks.createTaskOnce(db, args, { beforeCommit() {} }), { id: created.id, inserted: false });
  assert.equal(tasks.listTasks(db, {}).length, 1);
});

test('asynchronous and invalid commit guards cannot authorize a commit', t => {
  const { db, ws } = fixture(t), args = { title: 'Build the workshop', workspaceRoot: ws, requestId: randomUUID() };
  let invoked = false;
  assert.throws(() => tasks.createTaskOnce(db, args, { beforeCommit: async () => { invoked = true; } }), /synchronously/);
  assert.equal(invoked, false);
  assert.throws(() => tasks.createTaskOnce(db, args, { beforeCommit: () => Promise.reject(new Error('late')) }), /synchronously/);
  assert.throws(() => tasks.createTaskOnce(db, args, { beforeCommit: true }), /Invalid commit guard/);
  assert.throws(() => tasks.createTaskOnce(db, args, { busyAttempts: 0 }), /Invalid busy attempts/);
  assert.equal(tasks.listTasks(db, {}).length, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM task_creation_receipts').get().n, 0);
});

test('a grant that expires while waiting for the ledger prevents commit', async t => {
  const { db, file, ws } = fixture(t);
  db.exec('PRAGMA busy_timeout=0');
  const holder = spawn(processExec(), ['-e', `const {DatabaseSync}=require('node:sqlite'); const db=new DatabaseSync(process.argv[1]);
    db.exec('BEGIN IMMEDIATE'); console.log('locked'); setTimeout(()=>{db.exec('ROLLBACK');db.close()}, 500);`, file], { stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(() => { if (holder.exitCode === null && holder.signalCode === null) holder.kill('SIGKILL'); });
  await new Promise((resolve, reject) => { holder.stdout.once('data', resolve); holder.once('error', reject); holder.once('exit', code => reject(new Error(`lock holder exited early: ${code}`))); });
  let called = false;
  assert.throws(() => tasks.createTaskOnce(db, { title: 'Build the workshop', workspaceRoot: ws, requestId: randomUUID() }, {
    busyAttempts: 1, beforeCommit() { called = true; },
  }), /locked|busy/i);
  assert.equal(called, false);
  const deadline = Date.now() + 50;
  assert.throws(() => tasks.createTaskOnce(db, { title: 'Build the workshop', workspaceRoot: ws, requestId: randomUUID() }, {
    beforeCommit() { if (Date.now() >= deadline) throw new Error('Grant expired'); },
  }), /Grant expired/);
  assert.equal(tasks.listTasks(db, {}).length, 0);
  assert.equal(tasks.listTaskEvents(db, {}).length, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM task_creation_receipts').get().n, 0);
});
