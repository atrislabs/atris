const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-lock-home-'));
process.env.HOME = homeDir;
for (const key of Object.keys(process.env)) {
  if (key.startsWith('ATRIS_')) delete process.env[key];
}

const { acquireMissionLock, releaseMissionLock } = require('../commands/mission');

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-lock-root-'));
}

function lockPathFor(root, missionId) {
  return path.join(root, '.atris', 'state', `mission-${missionId}.lock`);
}

function plantLockFile(root, missionId, contents, mtime) {
  const lockFile = lockPathFor(root, missionId);
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  fs.writeFileSync(lockFile, contents);
  if (mtime) fs.utimesSync(lockFile, mtime, mtime);
  return lockFile;
}

test('acquires a free lock and writes the owner record', () => {
  const root = makeRoot();
  const lock = acquireMissionLock('m-alpha', root);
  try {
    assert.equal(lock.ok, true);
    assert.equal(lock.missionId, 'm-alpha');
    assert.equal(lock.driverPid, process.pid);
    assert.equal(lock.lockFile, lockPathFor(root, 'm-alpha'));
    assert.equal(fs.existsSync(lock.lockFile), true);
    const record = JSON.parse(fs.readFileSync(lock.lockFile, 'utf8'));
    assert.equal(record.pid, process.pid);
    assert.equal(record.mission_id, 'm-alpha');
    assert.equal(typeof record.started_at, 'string');
    assert.ok(!Number.isNaN(Date.parse(record.started_at)));
  } finally {
    releaseMissionLock(lock);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('reports busy while a live process holds the lock', () => {
  const root = makeRoot();
  const first = acquireMissionLock('m-beta', root);
  try {
    const second = acquireMissionLock('m-beta', root);
    assert.equal(second.ok, false);
    assert.equal(second.busy, true);
    assert.equal(second.lockFile, first.lockFile);
    assert.equal(second.holder.pid, process.pid);
    assert.equal(second.holder.mission_id, 'm-beta');
  } finally {
    releaseMissionLock(first);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('steals a lock whose recorded owner pid is dead', () => {
  const root = makeRoot();
  const dead = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  assert.ok(dead.pid > 0);
  plantLockFile(root, 'm-gamma', JSON.stringify({
    pid: dead.pid,
    started_at: '2020-01-01T00:00:00.000Z',
    mission_id: 'm-gamma',
  }));
  const lock = acquireMissionLock('m-gamma', root);
  try {
    assert.equal(lock.ok, true);
    const record = JSON.parse(fs.readFileSync(lock.lockFile, 'utf8'));
    assert.equal(record.pid, process.pid);
    assert.equal(record.mission_id, 'm-gamma');
  } finally {
    releaseMissionLock(lock);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('treats a fresh pidless lock as busy instead of stealing it', () => {
  const root = makeRoot();
  const lockFile = plantLockFile(root, 'm-delta', '');
  try {
    const result = acquireMissionLock('m-delta', root);
    assert.equal(result.ok, false);
    assert.equal(result.busy, true);
    assert.equal(result.lockFile, lockFile);
    assert.deepEqual(result.holder, {});
    assert.equal(fs.existsSync(lockFile), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('steals a pidless lock older than the creation window', () => {
  const root = makeRoot();
  const stale = new Date('2020-01-01T00:00:00.000Z');
  plantLockFile(root, 'm-epsilon', 'not json', stale);
  const lock = acquireMissionLock('m-epsilon', root);
  try {
    assert.equal(lock.ok, true);
    const record = JSON.parse(fs.readFileSync(lock.lockFile, 'utf8'));
    assert.equal(record.pid, process.pid);
    assert.equal(record.mission_id, 'm-epsilon');
  } finally {
    releaseMissionLock(lock);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('throws when .atris is blocked by a regular file', () => {
  const root = makeRoot();
  fs.writeFileSync(path.join(root, '.atris'), 'occupied');
  try {
    assert.throws(() => acquireMissionLock('m-zeta', root));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
