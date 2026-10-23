'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { rainmakerCommand } = require('../commands/rainmaker');

test('an existing backend without rainmaker prints the backend setup hint', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rainmaker-missing-script-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const previousRoot = process.env.ATRIS_BACKEND_ROOT;
  const previousPython = process.env.ATRIS_PYTHON;
  t.after(() => {
    if (previousRoot === undefined) delete process.env.ATRIS_BACKEND_ROOT;
    else process.env.ATRIS_BACKEND_ROOT = previousRoot;
    if (previousPython === undefined) delete process.env.ATRIS_PYTHON;
    else process.env.ATRIS_PYTHON = previousPython;
  });
  process.env.ATRIS_BACKEND_ROOT = root;
  // If the missing-script guard is bypassed, spawning fails immediately and
  // prints a different error without invoking Python or any external engine.
  process.env.ATRIS_PYTHON = path.join(root, 'nonexistent-python');
  const errors = [];
  t.mock.method(console, 'error', (...args) => errors.push(args));

  assert.equal(rainmakerCommand([]), 1);
  assert.deepEqual(errors, [['set ATRIS_BACKEND_ROOT to the backend workspace.']]);
});
