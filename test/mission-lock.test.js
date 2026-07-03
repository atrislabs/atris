const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { acquireMissionLock, releaseMissionLock, lockHolderIsDead } = require('../commands/mission');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-mission-lock-test-'));
}

function cleanupTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function writeLock(root, missionId, holder) {
  const dir = path.join(root, '.atris', 'state');
  fs.mkdirSync(dir, { recursive: true });
  const lockFile = path.join(dir, `mission-${missionId}.lock`);
  fs.writeFileSync(lockFile, JSON.stringify(holder));
  return lockFile;
}

// A pid that verifiably ran and exited — the stale-lock shape a crashed run leaves.
function deadPid() {
  const res = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' });
  assert.equal(res.status, 0);
  return res.pid;
}

test('acquireMissionLock breaks a lock whose holder pid is dead', () => {
  const dir = makeTempDir();
  try {
    const lockFile = writeLock(dir, 'm1', { pid: deadPid(), started_at: '2026-07-03T11:12:12.893Z', mission_id: 'm1' });
    const lock = acquireMissionLock('m1', dir);
    assert.equal(lock.ok, true, 'stale lock must be broken and re-acquired');
    const holder = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    assert.equal(holder.pid, process.pid, 'fresh lock must name the new holder');
    releaseMissionLock(lock);
    assert.equal(fs.existsSync(lockFile), false);
  } finally {
    cleanupTempDir(dir);
  }
});

test('acquireMissionLock stays busy for a live holder', () => {
  const dir = makeTempDir();
  try {
    // pid 1 (launchd/init) is always alive; kill(1, 0) is EPERM, not ESRCH.
    writeLock(dir, 'm2', { pid: 1, started_at: '2026-07-03T11:12:12.893Z', mission_id: 'm2' });
    const lock = acquireMissionLock('m2', dir);
    assert.equal(lock.ok, false);
    assert.equal(lock.busy, true);
    assert.equal(lock.holder.pid, 1);
  } finally {
    cleanupTempDir(dir);
  }
});

test('acquireMissionLock never breaks a lock without a parseable pid', () => {
  const dir = makeTempDir();
  try {
    const dirState = path.join(dir, '.atris', 'state');
    fs.mkdirSync(dirState, { recursive: true });
    fs.writeFileSync(path.join(dirState, 'mission-m3.lock'), 'not json');
    const lock = acquireMissionLock('m3', dir);
    assert.equal(lock.ok, false);
    assert.equal(lock.busy, true);
  } finally {
    cleanupTempDir(dir);
  }
});

test('lockHolderIsDead is conservative', () => {
  assert.equal(lockHolderIsDead({ pid: deadPid() }), true);
  assert.equal(lockHolderIsDead({ pid: 1 }), false, 'alive-but-not-ours is not dead');
  assert.equal(lockHolderIsDead({ pid: process.pid }), false, 'own pid is never dead');
  assert.equal(lockHolderIsDead({}), false);
  assert.equal(lockHolderIsDead({ pid: 'garbage' }), false);
  assert.equal(lockHolderIsDead(null), false);
});
