'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-autoland-phrase-home-'));
process.env.HOME = home;
for (const key of Object.keys(process.env)) {
  if (key.startsWith('ATRIS_')) delete process.env[key];
}

const { certifiedWorkLandsPhrase } = require('../lib/autoland');

const LIVE = 'certified work lands itself';
const WAITING = 'certified work lands once the hourly heartbeat runs (start one with atris autoland tick)';
// Fixed instant, well outside the two-hour window, so the stale case
// does not depend on today's date or the time zone.
const STALE_MTIME_SEC = Date.UTC(2000, 0, 1) / 1000;

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-autoland-phrase-'));
}

function writeTick(root, name, mtimeSec) {
  const dir = path.join(root, 'atris', 'runs');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, '{}\n');
  fs.utimesSync(file, mtimeSec, mtimeSec);
  return file;
}

test.after(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

test('a receipt from this hour says certified work lands itself', () => {
  const root = tempRoot();
  try {
    writeTick(root, 'autoland-tick-live.json', Date.now() / 1000);
    assert.equal(certifiedWorkLandsPhrase(root), LIVE);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an old receipt stays waiting, and the last filename wins over a fresher earlier name', () => {
  const root = tempRoot();
  try {
    writeTick(root, 'autoland-tick-old.json', STALE_MTIME_SEC);
    assert.equal(certifiedWorkLandsPhrase(root), WAITING);

    // Sort is by name, not by age. This fresher file sorts first, so the
    // old one is still the receipt that counts.
    writeTick(root, 'autoland-tick-a.json', Date.now() / 1000);
    assert.equal(certifiedWorkLandsPhrase(root), WAITING);

    writeTick(root, 'autoland-tick-z.json', Date.now() / 1000);
    assert.equal(certifiedWorkLandsPhrase(root), LIVE);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a missing folder, a bad root, or receipts that do not count stay on the waiting phrase', () => {
  const root = tempRoot();
  try {
    assert.equal(certifiedWorkLandsPhrase(root), WAITING);
    assert.equal(certifiedWorkLandsPhrase(null), WAITING);
    assert.equal(certifiedWorkLandsPhrase(undefined), WAITING);

    const runs = path.join(root, 'atris', 'runs');
    fs.mkdirSync(runs, { recursive: true });
    assert.equal(certifiedWorkLandsPhrase(root), WAITING);

    fs.writeFileSync(path.join(runs, 'autoland-tick-live.txt'), '{}\n');
    fs.writeFileSync(path.join(runs, 'notes.json'), '{}\n');
    assert.equal(certifiedWorkLandsPhrase(root), WAITING);

    const fileRoot = path.join(root, 'not-a-directory');
    fs.writeFileSync(fileRoot, 'nope\n');
    assert.equal(certifiedWorkLandsPhrase(fileRoot), WAITING);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
