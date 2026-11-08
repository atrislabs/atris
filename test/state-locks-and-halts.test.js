'use strict';

// Exclusive locks steal stale holders without deleting a fresh one, release
// only their own lock, and operator halts survive a long in-flight writer.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-state-locks-home-'));
for (const key of Object.keys(process.env)) {
  if (key.startsWith('ATRIS_')) delete process.env[key];
}
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.ATRIS_SKIP_UPDATE_CHECK = '1';

const { acquireFileLock, stealStaleLock } = require('../lib/file-lock');
const { acquireRunLock } = require('../lib/campaign-run-lock');
const { clearStaleStop, requestStop, stopRequested } = require('../commands/autopilot-front');
const mission = require('../commands/mission');
const { sweepFleetReceipts } = require('../lib/engine-receipt-sweep');

const DEAD_PID = 2 ** 22 + 12345;

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-state-locks-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function age(file, ms) {
  const when = new Date(Date.now() - ms);
  fs.utimesSync(file, when, when);
}

test('file lock: second taker is refused while the first holds it', (t) => {
  const file = path.join(tempDir(t), 'x.lock');
  const first = acquireFileLock(file);
  assert.equal(first.ok, true);
  const second = acquireFileLock(file);
  assert.equal(second.ok, false);
  assert.equal(second.holder.pid, process.pid);
  assert.equal(first.release(), true);
  assert.equal(fs.existsSync(file), false);
});

test('file lock: release leaves a lock that now belongs to someone else', (t) => {
  const file = path.join(tempDir(t), 'x.lock');
  const mine = acquireFileLock(file);
  // Another process stole it as stale and now owns the path.
  fs.unlinkSync(file);
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, token: 'theirs', at: new Date().toISOString() }));
  assert.equal(mine.release(), false);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).token, 'theirs');
});

test('file lock: a dead holder is taken over, a too-old live holder too', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'x.lock');
  fs.writeFileSync(file, JSON.stringify({ pid: DEAD_PID, host: os.hostname(), at: new Date().toISOString() }));
  const lock = acquireFileLock(file);
  assert.equal(lock.ok, true);
  lock.release();
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, at: Date.now() - 60 * 60 * 1000 }));
  const old = acquireFileLock(file, { staleAfterMs: 55 * 60 * 1000 });
  assert.equal(old.ok, true);
  old.release();
  assert.deepEqual(fs.readdirSync(dir), [], 'no tombstones left behind');
});

test('file lock: an unreadable lock is held while young, stale once old', (t) => {
  const file = path.join(tempDir(t), 'x.lock');
  fs.writeFileSync(file, '');
  assert.equal(acquireFileLock(file).ok, false);
  age(file, 60 * 1000);
  const lock = acquireFileLock(file);
  assert.equal(lock.ok, true);
  lock.release();
});

test('stale steal puts back a lock that was replaced after it was judged', (t) => {
  const file = path.join(tempDir(t), 'x.lock');
  fs.writeFileSync(file, 'stale');
  const judged = fs.statSync(file);
  // Between judging and stealing, another waiter took over.
  fs.unlinkSync(file);
  fs.writeFileSync(file, 'fresh owner');
  stealStaleLock(file, judged, 'stale');
  assert.equal(fs.readFileSync(file, 'utf8'), 'fresh owner');
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['x.lock']);
});

test('campaign run lock: an unreadable young lock is held, not deleted', (t) => {
  const home = tempDir(t);
  const file = path.join(home, 'campaigns', 'cmp-1', 'run.lock');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '');
  const busy = acquireRunLock(home, 'cmp-1');
  assert.equal(busy.ok, false);
  assert.equal(fs.existsSync(file), true);
  age(file, 60 * 1000);
  const lock = acquireRunLock(home, 'cmp-1');
  assert.equal(lock.ok, true);
  lock.release();
  assert.equal(fs.existsSync(file), false);
});

test('autopilot start keeps a stop issued after launch, clears an older one', (t) => {
  const root = tempDir(t);
  requestStop(root);
  assert.equal(clearStaleStop(root, Date.now() - 60 * 1000), true);
  assert.equal(stopRequested(root), true);
  const stopFile = path.join(root, '.atris', 'state', 'autopilot.stop');
  fs.writeFileSync(stopFile, `${new Date(Date.now() - 10 * 60 * 1000).toISOString()}\n`);
  age(stopFile, 10 * 60 * 1000);
  assert.equal(clearStaleStop(root, Date.now() - 60 * 1000), false);
  assert.equal(stopRequested(root), false);
});

test('mission lock: a dead holder is stolen; release spares a stolen lock', (t) => {
  const root = tempDir(t);
  const lockFile = path.join(root, '.atris', 'state', 'mission-m1.lock');
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  fs.writeFileSync(lockFile, JSON.stringify({ pid: DEAD_PID, mission_id: 'm1' }));
  const lock = mission.acquireMissionLock('m1', root);
  assert.equal(lock.ok, true);
  assert.equal(JSON.parse(fs.readFileSync(lockFile, 'utf8')).pid, process.pid);
  // Someone replaces the path; this lock must not delete theirs.
  fs.unlinkSync(lockFile);
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, mission_id: 'm1', other: true }));
  mission.releaseMissionLock(lock);
  assert.equal(JSON.parse(fs.readFileSync(lockFile, 'utf8')).other, true);
});

function writeLedger(root, rows) {
  const file = path.join(root, '.atris', 'state', 'missions.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
}

test('a stop recorded during a tick wins over the tick save', (t) => {
  const root = tempDir(t);
  const baseline = { id: 'm1', status: 'running', objective: 'x', updated_at: '2026-01-01T00:00:00Z' };
  writeLedger(root, [baseline, {
    ...baseline, status: 'stopped', stopped_at: '2026-01-01T00:05:00Z',
    stop_reason: 'stopped by operator', next_action: 'mission stopped', updated_at: '2026-01-01T00:05:00Z',
  }]);
  const halted = mission.missionHaltedSince(baseline, root);
  assert.equal(halted.status, 'stopped');
  const merged = mission.keepOperatorHalt({ ...baseline, status: 'ready', last_tick_index: 3, stop_reason: null }, halted);
  assert.equal(merged.status, 'stopped');
  assert.equal(merged.stop_reason, 'stopped by operator');
  assert.equal(merged.last_tick_index, 3, 'tick progress still lands');
  // No halt since the baseline: nothing to keep.
  assert.equal(mission.missionHaltedSince({ ...baseline, status: 'stopped' }, root), null);
});

test('stop keeps tick progress saved while it ran', (t) => {
  const root = tempDir(t);
  const seen = { id: 'm1', status: 'running', last_tick_index: 1, updated_at: '2026-01-01T00:00:00Z' };
  writeLedger(root, [seen, { ...seen, last_tick_index: 2, updated_at: '2026-01-01T00:01:00Z' }]);
  assert.equal(mission.withLatestMissionProgress(seen, root).last_tick_index, 2);
});

test('running mission whose recorded driver died a day ago is not live', (t) => {
  const root = tempDir(t);
  const m = { id: 'mission-deadbeef', status: 'running', last_tick_at: new Date(Date.now() - 2 * 86400000).toISOString() };
  // No driver record: a session-driven run, still live.
  assert.equal(mission.isLiveInFlightMission(m, Date.now(), root), true);
  const stateFile = path.join(root, '.atris', 'state', 'mission-driver-deadbeef.json');
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({ pid: DEAD_PID, started_at: m.last_tick_at }));
  assert.equal(mission.isLiveInFlightMission(m, Date.now(), root), false);
  // A recent tick keeps it live even with the driver gone.
  assert.equal(mission.isLiveInFlightMission({ ...m, last_tick_at: new Date().toISOString() }, Date.now(), root), true);
});

test('fleet sweep marks a crashed old flight presumed dead and spares live or young ones', (t) => {
  const root = tempDir(t);
  const runs = path.join(root, 'atris', 'runs');
  fs.mkdirSync(runs, { recursive: true });
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const write = (name, value, ageMs) => {
    const file = path.join(runs, name);
    fs.writeFileSync(file, JSON.stringify(value));
    if (ageMs) age(file, ageMs);
    return file;
  };
  const dead = write('fleet-1.json', { at: old, status: 'running', pid: DEAD_PID, results: [] }, 2 * 3600000);
  const alive = write('fleet-2.json', { at: old, status: 'running', pid: process.pid, results: [] }, 2 * 3600000);
  const young = write('dispatch-3.json', { schema: 'atris.dispatch_receipt.v1', at: new Date().toISOString(), status: 'running', pid: DEAD_PID });
  const done = write('fleet-4.json', { at: old, status: 'completed', pid: DEAD_PID, results: [] }, 2 * 3600000);
  const summary = sweepFleetReceipts(root);
  assert.deepEqual(summary, { scanned: 3, finalized: 1, skipped_alive: 1, skipped_young: 1 });
  assert.equal(JSON.parse(fs.readFileSync(dead, 'utf8')).status, 'presumed_dead');
  assert.equal(JSON.parse(fs.readFileSync(alive, 'utf8')).status, 'running');
  assert.equal(JSON.parse(fs.readFileSync(young, 'utf8')).status, 'running');
  assert.equal(JSON.parse(fs.readFileSync(done, 'utf8')).status, 'completed');
});
