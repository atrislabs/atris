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
  assert.deepEqual(tasks.expireLeases(db, { now: 3600000 }), []);
  const result = tasks.expireLeases(db, { now: 3600001 });
  assert.deepEqual(result.map(x => x.id), [old]);
  assert.equal(tasks.getTask(db, old).status, 'open');
  assert.equal(tasks.getTask(db, old).metadata.lease, undefined);
  assert.equal(tasks.getTask(db, fresh).status, 'claimed');
  const event = db.prepare("SELECT payload FROM task_events WHERE task_id = ? AND event_type = 'claim_expired'").get(old);
  assert.deepEqual(JSON.parse(event.payload), { claimed_by: 'fleet-a', lease_until: '1970-01-01T01:00:00.000Z', last_seen_at: result[0].last_seen_at, reason: 'worker went silent: no sign of life for 60 minutes' });
  assert.deepEqual(tasks.expireLeases(db, { now: 3600001 }), []);
});
test('stale cleanup defaults to fleet, supports a named holder and dry run', (t) => {
  const db = setup(t), fleet = claimed(db, 'fleet-a'), human = claimed(db, 'person');
  const old = Date.parse('2020-01-01T00:00:00Z');
  db.prepare('UPDATE task_events SET created_at = ? WHERE task_id IN (?, ?)').run(old, fleet, human);
  const now = Date.parse('2020-01-20T00:00:00Z');
  const preview = tasks.expireLeases(db, { now, staleDays: 7, dryRun: true });
  assert.deepEqual(preview.map(x => x.id), [fleet]);
  assert.equal(tasks.getTask(db, fleet).status, 'claimed');
  const selected = tasks.expireLeases(db, { now, staleDays: 7, claimer: 'person' });
  assert.deepEqual(selected.map(x => x.id), [human]);
  assert.equal(selected[0].lease_until, '2020-01-01T01:00:00.000Z');
  assert.equal(selected[0].reason, 'stranded: no activity since 2020-01-01T00:00:00.000Z');
  assert.deepEqual(tasks.expireLeases(db, { now, staleDays: 7 }).map(x => x.id), [fleet]);
});
test('sweep command previews and filters without changing claims', (t) => {
  const db = setup(t), fleet = claimed(db, 'fleet-cli'), person = claimed(db, 'person-cli');
  const old = Date.now() - 10 * 86400000;
  db.prepare('UPDATE task_events SET created_at = ? WHERE task_id IN (?, ?)').run(old, fleet, person);
  const { spawnSync } = require('node:child_process');
  const run = (...args) => spawnSync(process.execPath, [path.join(__dirname, '../bin/atris.js'), 'task', 'sweep', '--json', '--stale-days', '7', ...args], { env: { ...process.env, ATRIS_TASKS_DB: db.location() }, encoding: 'utf8' });
  const preview = run('--dry-run');
  assert.equal(preview.status, 0, preview.stderr);
  assert.deepEqual(JSON.parse(preview.stdout).tasks.map(x => x.id), [fleet]);
  assert.equal(tasks.getTask(db, fleet).status, 'claimed');
  const selected = run('--claimer', 'person-cli');
  assert.equal(selected.status, 0, selected.stderr);
  assert.deepEqual(JSON.parse(selected.stdout).tasks.map(x => x.id), [person]);
  assert.equal(tasks.getTask(db, person).status, 'open');
  assert.equal(tasks.getTask(db, fleet).status, 'claimed');
});
