'use strict';

// withFileLock runs a function while one lock file is held. These tests cover
// taking and releasing the lock, refusing a lock another live writer holds,
// and clearing a lock whose holder died or went stale. Every clock value is
// passed in, and no real process is needed: pid 0 is never a live writer.

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { withFileLock } = require('../lib/handoff-wake');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-wake-lock-'));
process.env.HOME = TMP;
for (const key of Object.keys(process.env)) {
  if (key.startsWith('ATRIS_')) delete process.env[key];
}
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const FIXED = Date.UTC(2026, 0, 1, 12, 0, 0);
const LOCKED_MESSAGE = 'handoff-wake.lock stayed locked by another writer';

// Writes a lock file as another writer would leave it, with a fixed mtime.
function plantLock(lockFile, owner) {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  fs.writeFileSync(lockFile, JSON.stringify(owner));
  fs.utimesSync(lockFile, new Date(FIXED), new Date(FIXED));
}

test('runs fn, returns its value, and removes the lock afterward', () => {
  const lockFile = path.join(TMP, 'normal', 'nested', 'handoff-wake.lock');
  let held = null;

  const out = withFileLock(lockFile, () => {
    held = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    return 'done';
  }, { now: () => FIXED });

  assert.equal(out, 'done');
  assert.deepEqual(held, { pid: process.pid, at: FIXED });
  assert.equal(fs.existsSync(lockFile), false);
});

test('a throw inside fn reaches the caller and still releases the lock', () => {
  const lockFile = path.join(TMP, 'throws', 'handoff-wake.lock');

  assert.throws(
    () => withFileLock(lockFile, () => { throw new Error('boom'); }, { now: () => FIXED }),
    { message: 'boom' },
  );
  assert.equal(fs.existsSync(lockFile), false);
  assert.equal(withFileLock(lockFile, () => 'again', { now: () => FIXED }), 'again');
});

test('refuses to run fn while a live writer holds a fresh lock', () => {
  const lockFile = path.join(TMP, 'held', 'handoff-wake.lock');
  plantLock(lockFile, { pid: process.pid, at: FIXED });
  let ran = false;

  assert.throws(
    () => withFileLock(lockFile, () => { ran = true; }, { waitMs: 0, now: () => FIXED + 1000 }),
    { message: LOCKED_MESSAGE },
  );
  assert.equal(ran, false);
  // The lock belongs to the other writer, so it must not be removed.
  assert.deepEqual(JSON.parse(fs.readFileSync(lockFile, 'utf8')), { pid: process.pid, at: FIXED });
});

test('a second call inside fn cannot take the same lock', () => {
  const lockFile = path.join(TMP, 'nested-call', 'handoff-wake.lock');
  let innerError = null;

  const out = withFileLock(lockFile, () => {
    // Pin the file's age so the inner call sees a fresh, live holder.
    fs.utimesSync(lockFile, new Date(FIXED), new Date(FIXED));
    try {
      withFileLock(lockFile, () => 'inner', { waitMs: 0, now: () => FIXED });
    } catch (error) {
      innerError = error;
    }
    return 'outer';
  }, { now: () => FIXED });

  assert.equal(out, 'outer');
  assert.equal(innerError && innerError.message, LOCKED_MESSAGE);
  assert.equal(fs.existsSync(lockFile), false);
});

test('clears a lock whose holder is no longer running', () => {
  const lockFile = path.join(TMP, 'dead-holder', 'handoff-wake.lock');
  // pid 0 is never a live writer, so the holder counts as dead.
  plantLock(lockFile, { pid: 0, at: FIXED });

  const out = withFileLock(lockFile, () => 'took it', { waitMs: 0, now: () => FIXED + 1000 });

  assert.equal(out, 'took it');
  assert.equal(fs.existsSync(lockFile), false);
});

test('clears a lock older than staleMs even when its holder is alive', () => {
  const lockFile = path.join(TMP, 'stale', 'handoff-wake.lock');
  plantLock(lockFile, { pid: process.pid, at: FIXED });

  const out = withFileLock(lockFile, () => 'took it', {
    staleMs: 1000,
    waitMs: 0,
    now: () => FIXED + 2000,
  });

  assert.equal(out, 'took it');
  assert.equal(fs.existsSync(lockFile), false);
});
