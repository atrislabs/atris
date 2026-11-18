'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID, randomBytes, createHash } = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const tasks = require('../lib/task-db');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-packet-test-'));
  const file = path.join(dir, 'tasks.db');
  const db = tasks.open(file);
  t.after(() => { tasks.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { db, file, ws: path.join(dir, 'workspace') };
}
function args(ws, overrides = {}) {
  return { workspaceRoot: ws, requestId: randomUUID(), salt: randomBytes(32).toString('hex'), packet: { title: '  Build city  ', goal: ' Help people ', summary: 'First line\nSecond line\tTabbed', exit: ' Done ', proof: ' Record proof ' }, ...overrides };
}
function create(db, input, options) { return tasks.createTaskOnceWithPacket(db, input, options); }
function count(db, table) { return db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n; }

test('packet creation stores canonical context and an independent salted immutable witness', t => {
  const { db, ws } = fixture(t), a = args(ws);
  const first = create(db, a);
  assert.equal(tasks.guardedTaskPacketCreationVersion, 2);
  assert.equal(first.inserted, true);
  const row = tasks.getTask(db, first.id);
  assert.equal(row.title, 'Build city');
  assert.equal(row.status, 'open');
  assert.equal(row.claimed_by, null);
  assert.equal(row.metadata.task_goal, 'Help people');
  assert.equal(row.metadata.task_summary, 'First line\nSecond line\tTabbed');
  assert.equal(row.metadata.exit_condition, 'Done');
  assert.equal(row.metadata.proof_needed, 'Record proof');
  const digest = createHash('sha256').update(JSON.stringify(['atris-city-task-packet-v1', a.salt, 'Build city', 'Help people', 'First line\nSecond line\tTabbed', 'Done', 'Record proof'])).digest('hex');
  const receipt = db.prepare('SELECT * FROM task_creation_packet_receipts').get();
  assert.equal(receipt.digest, digest);
  assert.equal(receipt.salt, a.salt);
  assert.equal(receipt.packet_version, 1);
  assert.equal(receipt.task_id, first.id);
  assert.deepEqual(create(db, a), { id: first.id, inserted: false });
  for (const sql of ['DELETE FROM task_creation_packet_receipts', "UPDATE task_creation_packet_receipts SET digest = 'bad'", 'INSERT OR REPLACE INTO task_creation_packet_receipts SELECT * FROM task_creation_packet_receipts']) assert.throws(() => db.exec(sql), /immutable/);
  db.prepare('UPDATE tasks SET metadata = ? WHERE id = ?').run(JSON.stringify({ task_goal: 'later edit' }), first.id);
  assert.deepEqual(create(db, a), { id: first.id, inserted: false });
  assert.equal(db.prepare('SELECT digest FROM task_creation_packet_receipts').get().digest, digest);
});

test('replays reject changed packet, salt, workspace, title and ambiguous original events', t => {
  const { db, ws } = fixture(t), a = args(ws), original = create(db, a);
  for (const field of ['title', 'goal', 'summary', 'exit', 'proof']) assert.throws(() => create(db, { ...a, packet: { ...a.packet, [field]: 'different' } }), /identity conflict/);
  assert.throws(() => create(db, { ...a, salt: '0'.repeat(64) }), /identity conflict/);
  assert.throws(() => create(db, { ...a, workspaceRoot: `${ws}-other` }), /identity conflict/);
  db.prepare("UPDATE task_events SET payload = '{}' WHERE task_id = ?").run(original.id);
  assert.throws(() => create(db, a), /identity conflict/);
  assert.equal(count(db, 'tasks'), 1);
});

test('deleted and moved tasks never get recreated, even without the original event', t => {
  const { db, ws } = fixture(t), a = args(ws), made = create(db, a);
  db.prepare('DELETE FROM task_events WHERE task_id = ?').run(made.id);
  db.prepare('DELETE FROM tasks WHERE id = ?').run(made.id);
  assert.throws(() => create(db, a), /identity conflict/);
  assert.equal(count(db, 'tasks'), 0);
  assert.equal(count(db, 'task_creation_packet_receipts'), 1);
  const b = args(ws), moved = create(db, b);
  db.prepare('UPDATE tasks SET workspace_root = ? WHERE id = ?').run(`${ws}-other`, moved.id);
  assert.throws(() => create(db, b), /identity conflict/);
});

test('invalid packet and Unicode inputs do not start a transaction', t => {
  const { db, ws } = fixture(t), a = args(ws);
  for (const packet of [null, [], { title: '' }, { title: 'ok', extra: 'no' }, { title: '\ud800' }, { title: 'ok\nno' }, { title: 'ok', goal: '\udc00' }, { title: 'ok', goal: '\u202etest' }, { title: 'ok', goal: '\x85' }, { title: 'ok', goal: 1 }, { title: 'ok', goal: 'a'.repeat(1001) }, { title: 'a'.repeat(2001) }]) assert.throws(() => create(db, { ...a, packet }));
  assert.throws(() => create(db, { ...a, salt: 'a'.repeat(63) }));
  assert.equal(count(db, 'tasks'), 0);
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name = 'task_creation_packet_receipts'").get().n, 0);
  const b = args(ws, { packet: { title: ' 😀 ', goal: '😀'.repeat(500), summary: '', proof: '\tcontent\nnext\t' } });
  assert.equal(create(db, b).inserted, true);
  assert.equal(tasks.getTask(db, create(db, b).id).metadata.task_goal.length, 1000);
});

test('guard and insert failures roll back schema migration, event, task and receipts', t => {
  const { db, ws } = fixture(t), a = args(ws);
  assert.throws(() => create(db, a, { beforeCommit() { throw new Error('expired'); } }), /expired/);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 3);
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name = 'task_creation_packet_receipts'").get().n, 0);
  assert.equal(count(db, 'tasks'), 0);
  assert.equal(count(db, 'task_events'), 0);
  assert.equal(count(db, 'task_creation_receipts'), 0);
  db.exec("CREATE TRIGGER fixture_reject BEFORE INSERT ON task_events BEGIN SELECT RAISE(ABORT, 'fixture failure'); END");
  assert.throws(() => create(db, a), /fixture failure/);
  assert.equal(count(db, 'tasks'), 0);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 3);
  db.exec('DROP TRIGGER fixture_reject');
  assert.equal(create(db, a).inserted, true);
  assert.throws(() => create(db, a, { beforeCommit() { throw new Error('revoked'); } }), /revoked/);
});

test('partial or altered packet protection fails closed and marker downgrades preserve witness', t => {
  const { db, ws } = fixture(t), a = args(ws), made = create(db, a);
  for (const version of [2, 3, 4]) {
    db.exec(`PRAGMA user_version = ${version}`);
    assert.deepEqual(create(db, a), { id: made.id, inserted: false });
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 4);
  }
  db.exec('DROP TRIGGER task_creation_packet_receipts_no_update');
  assert.throws(() => create(db, args(ws)), /Unsupported task schema/);
  assert.equal(count(db, 'tasks'), 1);
  db.exec('PRAGMA user_version = 2');
  assert.throws(() => create(db, a), /Unsupported task schema/);
});

test('legacy title-only creation works and cannot become a packet by replay', t => {
  const { db, ws } = fixture(t), a = args(ws);
  const original = tasks.createTaskOnce(db, { title: a.packet.title, workspaceRoot: ws, requestId: a.requestId });
  assert.throws(() => create(db, a), /identity conflict/);
  assert.deepEqual(tasks.createTaskOnce(db, { title: a.packet.title, workspaceRoot: ws, requestId: a.requestId }), { id: original.id, inserted: false });
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name = 'task_creation_packet_receipts'").get().n, 0);
});

test('a lost child response reconciles committed packet exactly once', t => {
  const { db, file, ws } = fixture(t), a = args(ws);
  const script = `const { DatabaseSync } = require('node:sqlite'); const tasks = require(process.argv[1]); const db = new DatabaseSync(process.argv[2]); tasks.createTaskOnceWithPacket(db, JSON.parse(process.argv[3])); db.close();`;
  const child = spawnSync(process.execPath, ['-e', script, require.resolve('../lib/task-db'), file, JSON.stringify(a)], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  const replay = create(db, a);
  assert.equal(replay.inserted, false);
  assert.equal(count(db, 'tasks'), 1);
  assert.equal(count(db, 'task_events'), 1);
  assert.equal(count(db, 'task_creation_packet_receipts'), 1);
});

test('process death before commit rolls back and after commit replays the original task', t => {
  const { db, file, ws } = fixture(t), a = args(ws);
  const script = `const {DatabaseSync}=require('node:sqlite'); const tasks=require(process.argv[1]); const db=new DatabaseSync(process.argv[2]); const args=JSON.parse(process.argv[3]); const when=process.argv[4]; tasks.createTaskOnceWithPacket(db, args, {beforeCommit(){if(when==='before') process.kill(process.pid, 'SIGKILL');}}); if(when==='after') process.kill(process.pid, 'SIGKILL');`;
  const run = when => spawnSync(process.execPath, ['-e', script, require.resolve('../lib/task-db'), file, JSON.stringify(a), when], { encoding: 'utf8' });
  assert.equal(run('before').signal, 'SIGKILL');
  assert.equal(count(db, 'tasks'), 0);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 3);
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name = 'task_creation_packet_receipts'").get().n, 0);
  assert.equal(run('after').signal, 'SIGKILL');
  assert.equal(create(db, a).inserted, false);
  assert.equal(count(db, 'tasks'), 1);
  assert.equal(count(db, 'task_events'), 1);
  assert.equal(count(db, 'task_creation_packet_receipts'), 1);
});

test('an unprotected version 4 or unknown newer marker never creates a task', t => {
  const { db, ws } = fixture(t), a = args(ws);
  for (const version of [4, 5]) {
    db.exec(`PRAGMA user_version = ${version}`);
    assert.throws(() => create(db, a), /Unsupported task schema/);
    assert.equal(count(db, 'tasks'), 0);
  }
});

test('the caller migrates a version 2 ledger and packet schema in the same transaction', t => {
  const { db, ws } = fixture(t), a = args(ws);
  db.exec('DROP TABLE task_creation_receipts; PRAGMA user_version = 2');
  const guarded = {
    exec(sql) {
      db.exec(sql);
      if (sql === 'BEGIN IMMEDIATE') tasks.migrateTaskCreationSchemaV3(db);
    },
    prepare(sql) { return db.prepare(sql); },
  };
  assert.throws(() => create(guarded, a, { beforeCommit() { throw new Error('expired'); } }), /expired/);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 2);
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name IN ('task_creation_receipts','task_creation_packet_receipts')").get().n, 0);
  assert.equal(create(guarded, a).inserted, true);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 4);
  assert.equal(count(db, 'task_creation_receipts'), 1);
  assert.equal(count(db, 'task_creation_packet_receipts'), 1);
});

test('simultaneous packet writers create one task and reject a conflicting packet', async t => {
  const { db, file, ws } = fixture(t), a = args(ws);
  const script = `const {DatabaseSync}=require('node:sqlite'); const tasks=require(process.argv[1]); const db=new DatabaseSync(process.argv[2]); db.exec('PRAGMA busy_timeout=30000'); try { console.log(JSON.stringify(tasks.createTaskOnceWithPacket(db, JSON.parse(process.argv[3])))); } catch(e) { console.error(e.message); process.exitCode=1; } finally { db.close(); }`;
  const launch = input => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script, require.resolve('../lib/task-db'), file, JSON.stringify(input)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.stderr.on('data', chunk => { err += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, out, err }));
  });
  const same = await Promise.all([launch(a), launch(a)]);
  assert.deepEqual(same.map(x => x.code), [0, 0]);
  const outcomes = same.map(x => JSON.parse(x.out));
  assert.equal(new Set(outcomes.map(x => x.id)).size, 1);
  assert.equal(outcomes.filter(x => x.inserted).length, 1);
  const b = args(ws), conflict = { ...b, packet: { ...b.packet, summary: 'a different context' } };
  const competing = await Promise.all([launch(b), launch(conflict)]);
  assert.equal(competing.filter(x => x.code === 0).length, 1);
  assert.equal(competing.filter(x => x.code === 1 && /identity conflict/.test(x.err)).length, 1);
  assert.equal(count(db, 'tasks'), 2);
  assert.equal(count(db, 'task_events'), 2);
  assert.equal(count(db, 'task_creation_packet_receipts'), 2);
});
