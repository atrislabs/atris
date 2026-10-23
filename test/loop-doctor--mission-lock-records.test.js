'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { missionLockRecords } = require('../lib/loop-doctor');

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-mission-lock-records-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function stateDir(root) {
  const dir = path.join(root, '.atris', 'state');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeLock(dir, name, contents) {
  fs.writeFileSync(path.join(dir, name), contents, 'utf8');
}

test('classifies live and dead mission locks and sorts them by file name', (t) => {
  const root = tempRoot(t);
  const dir = stateDir(root);
  const seen = [];
  writeLock(dir, 'mission-zeta.lock', JSON.stringify({ pid: 9001, owner: 'runner' }));
  writeLock(dir, 'Mission-Beta.LOCK', JSON.stringify({ pid: 7 }));
  writeLock(dir, 'mission-alpha.lock', JSON.stringify({ pid: 42 }));
  writeLock(dir, 'notes.txt', 'not a lock');
  writeLock(dir, 'mission.lock', JSON.stringify({ pid: 99 }));
  writeLock(dir, 'lock-mission-extra.lock', JSON.stringify({ pid: 3 }));

  const records = missionLockRecords(root, (pid) => {
    seen.push(pid);
    return pid === 7 || pid === 9001;
  });

  assert.deepStrictEqual(seen, [7, 42, 9001]);
  assert.deepStrictEqual(records, [
    { lock: 'Mission-Beta.LOCK', reason: 'live-pid', pid: 7, stale: false },
    { lock: 'mission-alpha.lock', reason: 'dead-pid', pid: 42, stale: true },
    { lock: 'mission-zeta.lock', reason: 'live-pid', pid: 9001, stale: false },
  ]);
});

test('marks a bad lock stale and still reads a numeric string pid', (t) => {
  const root = tempRoot(t);
  const dir = stateDir(root);
  const seen = [];
  writeLock(dir, 'mission-text.lock', '{not json');
  writeLock(dir, 'mission-blank.lock', '');
  writeLock(dir, 'mission-zero.lock', JSON.stringify({ pid: 0 }));
  writeLock(dir, 'mission-neg.lock', JSON.stringify({ pid: -3 }));
  writeLock(dir, 'mission-frac.lock', JSON.stringify({ pid: 1.5 }));
  writeLock(dir, 'mission-nan.lock', JSON.stringify({ pid: 'nope' }));
  writeLock(dir, 'mission-gone.lock', JSON.stringify({ holder: 'runner' }));
  writeLock(dir, 'mission-str.lock', JSON.stringify({ pid: '15' }));
  writeLock(dir, 'readme.txt', 'ignore');
  fs.mkdirSync(path.join(dir, 'mission-dir.lock'));

  const records = missionLockRecords(root, (pid) => {
    seen.push(pid);
    return false;
  });

  assert.deepStrictEqual(seen, [15]);
  assert.deepStrictEqual(records, [
    { lock: 'mission-blank.lock', reason: 'unparseable', pid: null, stale: true },
    { lock: 'mission-dir.lock', reason: 'unparseable', pid: null, stale: true },
    { lock: 'mission-frac.lock', reason: 'unparseable', pid: null, stale: true },
    { lock: 'mission-gone.lock', reason: 'unparseable', pid: null, stale: true },
    { lock: 'mission-nan.lock', reason: 'unparseable', pid: null, stale: true },
    { lock: 'mission-neg.lock', reason: 'unparseable', pid: null, stale: true },
    { lock: 'mission-str.lock', reason: 'dead-pid', pid: 15, stale: true },
    { lock: 'mission-text.lock', reason: 'unparseable', pid: null, stale: true },
    { lock: 'mission-zero.lock', reason: 'unparseable', pid: null, stale: true },
  ]);
});

test('returns an empty list when the state folder is missing, empty, or not a folder', (t) => {
  const missing = tempRoot(t);
  assert.deepStrictEqual(missionLockRecords(missing, () => {
    throw new Error('pid check should not run');
  }), []);

  const blocked = tempRoot(t);
  fs.mkdirSync(path.join(blocked, '.atris'));
  fs.writeFileSync(path.join(blocked, '.atris', 'state'), 'not a directory');
  assert.deepStrictEqual(missionLockRecords(blocked, () => {
    throw new Error('pid check should not run');
  }), []);

  const empty = tempRoot(t);
  stateDir(empty);
  assert.deepStrictEqual(missionLockRecords(empty), []);
});
