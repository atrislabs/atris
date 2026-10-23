'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-release-mission-lock-home-'));
for (const key of Object.keys(process.env)) {
  if (key.startsWith('ATRIS_')) delete process.env[key];
}
process.env.HOME = home;
process.env.USERPROFILE = home;

const { releaseMissionLock } = require('../commands/mission');

function makeDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-release-mission-lock-'));
}

test('a held lock is closed and its file is removed', () => {
  const dir = makeDir();
  const lockFile = path.join(dir, 'mission-fixed.lock');
  const fd = fs.openSync(lockFile, 'wx');
  fs.writeSync(fd, '{"pid":4242,"mission_id":"mission-fixed"}');
  try {
    const lock = { ok: true, fd, lockFile, missionId: 'mission-fixed' };
    const result = releaseMissionLock(lock);
    assert.strictEqual(result, undefined);
    assert.strictEqual(lock.ok, true);
    assert.strictEqual(lock.fd, fd);
    assert.strictEqual(fs.existsSync(lockFile), false);
    assert.throws(() => fs.fstatSync(fd), { code: 'EBADF' });
  } finally {
    try { fs.closeSync(fd); } catch { /* already closed by release */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a lock with no descriptor still removes only its own file', () => {
  const dir = makeDir();
  try {
    const lockFile = path.join(dir, 'mission-edge.lock');
    const neighbor = path.join(dir, 'keep.txt');
    fs.writeFileSync(lockFile, 'held');
    fs.writeFileSync(neighbor, 'stay');

    const result = releaseMissionLock({ ok: true, fd: null, lockFile });
    assert.strictEqual(result, undefined);
    assert.strictEqual(fs.existsSync(lockFile), false);
    assert.strictEqual(fs.readFileSync(neighbor, 'utf8'), 'stay');

    const again = releaseMissionLock({ ok: true, fd: null, lockFile });
    assert.strictEqual(again, undefined);
    assert.strictEqual(fs.readFileSync(neighbor, 'utf8'), 'stay');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an empty or busy lock stays put, and a bad path does not throw', () => {
  const dir = makeDir();
  const lockFile = path.join(dir, 'mission-busy.lock');
  const fd = fs.openSync(lockFile, 'wx');
  fs.writeSync(fd, 'busy');
  try {
    assert.strictEqual(releaseMissionLock(null), undefined);
    assert.strictEqual(releaseMissionLock(undefined), undefined);
    assert.strictEqual(releaseMissionLock({}), undefined);
    assert.strictEqual(releaseMissionLock({ ok: false, fd, lockFile }), undefined);
    assert.strictEqual(releaseMissionLock({ ok: '', fd, lockFile }), undefined);
    assert.strictEqual(fs.readFileSync(lockFile, 'utf8'), 'busy');
    assert.strictEqual(fs.fstatSync(fd).isFile(), true);

    const notAFile = path.join(dir, 'not-a-file');
    fs.mkdirSync(notAFile);
    const releaseFd = fs.openSync(lockFile, 'r');
    const result = releaseMissionLock({ ok: true, fd: releaseFd, lockFile: notAFile });
    assert.strictEqual(result, undefined);
    assert.strictEqual(fs.statSync(notAFile).isDirectory(), true);
    assert.strictEqual(fs.readFileSync(lockFile, 'utf8'), 'busy');
    assert.throws(() => fs.fstatSync(releaseFd), { code: 'EBADF' });
  } finally {
    try { fs.closeSync(fd); } catch { /* left open on purpose until cleanup */ }
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});
