'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { acquireTickLock, lockFile } = require('../lib/idea-tick');

test('lock creation reports denied write access instead of treating it as contention', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-lock-access-'));
  const home = process.env.HOME;
  process.env.HOME = root;
  const state = path.dirname(lockFile(root));
  fs.mkdirSync(state, { recursive: true });
  fs.chmodSync(state, 0o500);
  try {
    assert.throws(() => acquireTickLock(root), (error) => error.code === 'EACCES');
  } finally {
    fs.chmodSync(state, 0o700);
    if (home === undefined) delete process.env.HOME;
    else process.env.HOME = home;
  }
});
