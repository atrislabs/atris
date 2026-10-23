const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Driver-lifecycle code reads these two env vars elsewhere in the module; the
// function under test ignores them, but clear them so a polluted environment
// can never change what we measure.
delete process.env.ATRIS_MISSION_DRIVER_DETACHED;
delete process.env.ATRIS_MISSION_DRIVER_PARENT_PID;

const { missionDriverHealth } = require('../commands/mission');

const MISSION_ID = 'mission-2026-01-01-demo-a1b2c3d4';
const SHORT_ID = 'a1b2c3d4'; // last 8 chars of the mission id
const mission = { id: MISSION_ID };

const STATE_REL = path.join('.atris', 'state', `mission-driver-${SHORT_ID}.json`);
const LOCK_REL = path.join('.atris', 'state', `mission-${MISSION_ID}.lock`);
const LOG_REL = path.join('atris', 'logs', `mission-${SHORT_ID}-driver.log`);

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-mission-driver-health-test-'));
}

function writeFile(root, rel, contents) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents, 'utf8');
}

// process.kill(pid, 0) throws for a dead pid and succeeds (or EPERMs) for a
// live one. Scan a high range so the check is proven on this machine rather
// than assumed from a hardcoded number.
function findDeadPid() {
  for (let pid = 4000000; pid < 4010000; pid += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error && error.code === 'EPERM') continue;
      return pid;
    }
  }
  assert.fail('could not find a dead pid');
}

test('missionDriverHealth reports nothing when no driver files exist', (t) => {
  const root = makeTempDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const health = missionDriverHealth(mission, root);

  assert.equal(health.alive, false);
  assert.equal(health.pid, null);
  assert.equal(health.started_at, null);
  assert.equal(health.source, null);
  assert.equal(health.state_path, null);
  assert.equal(health.log_path, LOG_REL);
});

test('missionDriverHealth reports a live driver from the driver state file', (t) => {
  const root = makeTempDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const startedAt = '2025-01-02T03:04:05.000Z';
  writeFile(root, STATE_REL, JSON.stringify({
    mission_id: MISSION_ID,
    pid: process.pid,
    started_at: startedAt,
    log_path: 'custom/driver.log',
  }));

  const health = missionDriverHealth(mission, root);

  assert.equal(health.alive, true);
  assert.equal(health.pid, process.pid);
  assert.equal(health.started_at, startedAt);
  assert.equal(health.source, 'driver_state');
  assert.equal(health.state_path, STATE_REL);
  assert.equal(health.log_path, 'custom/driver.log');
});

test('missionDriverHealth prefers a live lock owner over a dead driver state', (t) => {
  const root = makeTempDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const deadPid = findDeadPid();
  writeFile(root, STATE_REL, JSON.stringify({
    mission_id: MISSION_ID,
    pid: deadPid,
    started_at: '2025-01-02T03:04:05.000Z',
  }));
  const lockStartedAt = '2025-02-03T04:05:06.000Z';
  writeFile(root, LOCK_REL, JSON.stringify({
    pid: process.pid,
    started_at: lockStartedAt,
    mission_id: MISSION_ID,
  }));

  const health = missionDriverHealth(mission, root);

  assert.equal(health.alive, true);
  assert.equal(health.pid, process.pid);
  assert.equal(health.started_at, lockStartedAt);
  assert.equal(health.source, 'mission_lock');
  assert.equal(health.state_path, STATE_REL);
  assert.equal(health.log_path, LOG_REL);
});

test('missionDriverHealth reports a dead driver state as not alive', (t) => {
  const root = makeTempDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const deadPid = findDeadPid();
  const startedAt = '2025-03-04T05:06:07.000Z';
  writeFile(root, STATE_REL, JSON.stringify({
    mission_id: MISSION_ID,
    pid: deadPid,
    started_at: startedAt,
  }));

  const health = missionDriverHealth(mission, root);

  assert.equal(health.alive, false);
  assert.equal(health.pid, deadPid);
  assert.equal(health.started_at, startedAt);
  assert.equal(health.source, 'driver_state');
  assert.equal(health.state_path, STATE_REL);
  assert.equal(health.log_path, LOG_REL);
});

test('missionDriverHealth treats a corrupt driver state file as missing', (t) => {
  const root = makeTempDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  writeFile(root, STATE_REL, '{ not valid json');

  const health = missionDriverHealth(mission, root);

  assert.equal(health.alive, false);
  assert.equal(health.pid, null);
  assert.equal(health.started_at, null);
  assert.equal(health.source, null);
  // The file exists on disk even though its contents are unreadable.
  assert.equal(health.state_path, STATE_REL);
  assert.equal(health.log_path, LOG_REL);
});
