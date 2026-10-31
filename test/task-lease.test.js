'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tasks = require('../lib/task-db');

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claim-lease-'));
  const db = tasks.open(path.join(dir, 'tasks.db'));
  t.after(() => { tasks.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return db;
}
function claimed(db, holder) {
  const { id } = tasks.addTask(db, { title: holder, workspaceRoot: os.tmpdir() });
  assert.equal(tasks.claimTask(db, { id, claimedBy: holder }).claimed, true);
  return id;
}
test('lease set, renew and clear preserve task events', (t) => {
  const db = setup(t), id = claimed(db, 'fleet-a');
  const count = () => db.prepare('SELECT count(*) AS n FROM task_events WHERE task_id = ?').get(id).n;
  const before = count();
  assert.equal(tasks.setLease(db, { id, holder: 'fleet-a', pid: 5, now: 0 }), true);
  assert.deepEqual(tasks.getTask(db, id).metadata.lease, { until: '1970-01-01T01:00:00.000Z', minutes: 60, holder: 'fleet-a', pid: 5 });
  assert.equal(tasks.renewLease(db, { id, holder: 'fleet-a', pid: 5, now: 300000 }), true);
  assert.equal(tasks.getTask(db, id).metadata.lease.until, '1970-01-01T01:05:00.000Z');
  assert.equal(tasks.renewLease(db, { id, holder: 'fleet-a', pid: 6, now: 300000 }), false);
  assert.equal(tasks.clearLease(db, { id, holder: 'fleet-a' }), true);
  assert.equal(tasks.getTask(db, id).metadata.lease, undefined);
  assert.equal(count(), before);
});
test('a worker claim writes its lease in the same update', (t) => {
  const db = setup(t);
  const { id } = tasks.addTask(db, { title: 'worker', workspaceRoot: os.tmpdir() });
  assert.equal(tasks.claimTask(db, { id, claimedBy: 'fleet-a', leaseMinutes: 60, leasePid: 123 }).claimed, true);
  const row = tasks.getTask(db, id);
  assert.equal(row.status, 'claimed');
  assert.deepEqual(row.metadata.lease, { until: new Date(row.claimed_at + 3600000).toISOString(), minutes: 60, holder: 'fleet-a', pid: 123 });
});
test('release and ready remove the lease as they change status', (t) => {
  const db = setup(t), released = claimed(db, 'fleet-a'), ready = claimed(db, 'fleet-b');
  tasks.setLease(db, { id: released, holder: 'fleet-a' });
  tasks.setLease(db, { id: ready, holder: 'fleet-b' });
  assert.equal(tasks.releaseTask(db, { id: released, actor: 'fleet-a' }).released, true);
  assert.equal(tasks.getTask(db, released).metadata.lease, undefined);
  assert.equal(tasks.readyTask(db, { id: ready, actor: 'fleet-b', proof: 'checked' }).ready, true);
  assert.equal(tasks.getTask(db, ready).metadata.lease, undefined);
});
test('expired leases release once with the required event', (t) => {
  const db = setup(t), old = claimed(db, 'fleet-a'), fresh = claimed(db, 'human');
  tasks.setLease(db, { id: old, holder: 'fleet-a', now: 0 });
  tasks.setLease(db, { id: fresh, holder: 'human', now: 10000000 });
  assert.deepEqual(tasks.expireLeases(db, { now: 3600000, isAlive: () => false }), []);
  const result = tasks.expireLeases(db, { now: 3600001, isAlive: () => false });
  assert.deepEqual(result.map(x => x.id), [old]);
  assert.equal(tasks.getTask(db, old).status, 'open');
  assert.equal(tasks.getTask(db, old).metadata.lease, undefined);
  assert.equal(tasks.getTask(db, fresh).status, 'claimed');
  const event = db.prepare("SELECT payload FROM task_events WHERE task_id = ? AND event_type = 'claim_expired'").get(old);
  assert.deepEqual(JSON.parse(event.payload), { claimed_by: 'fleet-a', lease_until: '1970-01-01T01:00:00.000Z', last_seen_at: result[0].last_seen_at, reason: 'worker stopped without reporting back within 60 minutes' });
  assert.deepEqual(tasks.expireLeases(db, { now: 3600001, isAlive: () => false }), []);
});
test('an expired lease remains claimed while its worker is alive', (t) => {
  const db = setup(t), id = claimed(db, 'fleet-a');
  tasks.setLease(db, { id, holder: 'fleet-a', pid: process.pid, now: 0 });
  assert.deepEqual(tasks.expireLeases(db, { now: 3600001 }), []);
  assert.equal(tasks.getTask(db, id).status, 'claimed');
});
test('a lease over 12 hours past its deadline is released even if its pid is alive', (t) => {
  const db = setup(t), id = claimed(db, 'fleet-a');
  tasks.setLease(db, { id, holder: 'fleet-a', pid: process.pid, now: 0 });
  assert.deepEqual(tasks.expireLeases(db, { now: 3600000 + 13 * 3600000 }).map(x => x.id), [id]);
  assert.equal(tasks.getTask(db, id).status, 'open');
});
test('stale cleanup defaults to fleet, supports a named holder and dry run', (t) => {
  const db = setup(t), fleet = claimed(db, 'fleet-a'), human = claimed(db, 'person');
  const old = Date.parse('2020-01-01T00:00:00Z');
  db.prepare('UPDATE task_events SET created_at = ? WHERE task_id IN (?, ?)').run(old, fleet, human);
  const now = Date.parse('2020-01-20T00:00:00Z');
  const preview = tasks.expireLeases(db, { now, staleDays: 7, dryRun: true, isAlive: () => false });
  assert.deepEqual(preview.map(x => x.id), [fleet]);
  assert.equal(tasks.getTask(db, fleet).status, 'claimed');
  const selected = tasks.expireLeases(db, { now, staleDays: 7, claimer: 'person', isAlive: () => false });
  assert.deepEqual(selected.map(x => x.id), [human]);
  assert.equal(selected[0].lease_until, '2020-01-01T01:00:00.000Z');
  assert.equal(selected[0].reason, 'stranded with no activity for over 7 days');
  assert.deepEqual(tasks.expireLeases(db, { now, staleDays: 7, isAlive: () => false }).map(x => x.id), [fleet]);
});
test('sweep command previews and filters without changing claims', (t) => {
  const db = setup(t), fleet = claimed(db, 'fleet-cli'), person = claimed(db, 'person-cli');
  const old = Date.now() - 10 * 86400000;
  db.prepare('UPDATE task_events SET created_at = ? WHERE task_id IN (?, ?)').run(old, fleet, person);
  const { spawnSync } = require('node:child_process');
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-cwd-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const run = (...args) => spawnSync(process.execPath, [path.join(__dirname, '../bin/atris.js'), 'task', 'sweep', '--json', '--stale-days', '7', ...args], { cwd, env: { ...process.env, ATRIS_TASKS_DB: db.location() }, encoding: 'utf8' });
  const preview = run('--dry-run');
  assert.equal(preview.status, 0, preview.stderr);
  assert.deepEqual(JSON.parse(preview.stdout).tasks.map(x => x.id), [fleet]);
  assert.equal(tasks.getTask(db, fleet).status, 'claimed');
  assert.deepEqual(fs.readdirSync(cwd), []);
  const selected = run('--claimer', 'person-cli');
  assert.equal(selected.status, 0, selected.stderr);
  assert.deepEqual(JSON.parse(selected.stdout).tasks.map(x => x.id), [person]);
  assert.equal(tasks.getTask(db, person).status, 'open');
  assert.equal(tasks.getTask(db, fleet).status, 'claimed');
});

test('claimer filters expired leases as well as stale claims', (t) => {
  const db = setup(t), alice = claimed(db, 'alice'), bob = claimed(db, 'bob');
  tasks.setLease(db, { id: alice, holder: 'alice', now: 0 });
  tasks.setLease(db, { id: bob, holder: 'bob', now: 0 });
  assert.deepEqual(tasks.expireLeases(db, { now: 3600001, claimer: 'alice', isAlive: () => false }).map(x => x.id), [alice]);
  assert.equal(tasks.getTask(db, bob).status, 'claimed');
});

function raceOnUpdate(db, change) {
  return { prepare(sql) {
    const statement = db.prepare(sql);
    if (!/UPDATE tasks SET metadata = \?|UPDATE tasks\s+SET status = 'review'/.test(sql)) return statement;
    return { run(...args) { change(); return statement.run(...args); } };
  } };
}
test('renewal cannot overwrite a reclaimed lease', (t) => {
  const db = setup(t), id = claimed(db, 'alice');
  tasks.setLease(db, { id, holder: 'alice', pid: 1 });
  const raced = raceOnUpdate(db, () => {
    db.prepare("UPDATE tasks SET claimed_at = claimed_at + 1, metadata = ? WHERE id = ?").run(JSON.stringify({ lease: { holder: 'alice', pid: 2, minutes: 60 } }), id);
  });
  assert.equal(tasks.renewLease(raced, { id, holder: 'alice', pid: 1 }), false);
  assert.equal(tasks.getTask(db, id).metadata.lease.pid, 2);
});
test('proof cannot move a new claim into review', (t) => {
  const db = setup(t), id = claimed(db, 'alice');
  const raced = raceOnUpdate(db, () => {
    db.prepare("UPDATE tasks SET claimed_by = 'bob', claimed_at = claimed_at + 1, metadata = ? WHERE id = ?").run(JSON.stringify({ lease: { holder: 'bob', pid: 2 } }), id);
  });
  assert.deepEqual(tasks.readyTask(raced, { id, actor: 'alice', proof: 'checked' }), { ready: false, reason: 'claim changed hands' });
  assert.equal(tasks.getTask(db, id).metadata.lease.holder, 'bob');
});

test('other dry runs do not sweep expired leases', (t) => {
  const db = setup(t), id = claimed(db, 'alice');
  tasks.setLease(db, { id, holder: 'alice', pid: 99999999, now: 0 });
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dry-run-cwd-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const result = require('node:child_process').spawnSync(process.execPath, [path.join(__dirname, '../bin/atris.js'), 'task', 'clear-done', '--dry-run'], { cwd, env: { ...process.env, ATRIS_TASKS_DB: db.location() }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(tasks.getTask(db, id).status, 'claimed');
  assert.deepEqual(fs.readdirSync(cwd), []);
});
test('sweep preview does not create a missing database', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-empty-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const result = require('node:child_process').spawnSync(process.execPath, [path.join(__dirname, '../bin/atris.js'), 'task', 'sweep', '--dry-run'], { cwd, env: { ...process.env, ATRIS_TASKS_DB: path.join(cwd, 'missing.db') }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(fs.readdirSync(cwd), []);
});
