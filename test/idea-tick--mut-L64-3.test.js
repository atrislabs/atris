'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { acquireTickLock, lockFile, releaseTickLock } = require('../lib/idea-tick');

test('a lock with a zero process id can be reclaimed', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-zero-pid-'));
  let held;
  try {
    const file = lockFile(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      pid: 0,
      token: 'abandoned',
    }));
    held = acquireTickLock(root);
    assert.equal(held.ok, true);
  } finally {
    if (held && held.ok) releaseTickLock(held);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
