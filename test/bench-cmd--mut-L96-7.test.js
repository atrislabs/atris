'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('bench run JSON retains an explicitly selected null engine', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-engine-option-'));
  const originalHome = process.env.HOME;
  const originalCwd = process.cwd();
  const originalLog = console.log;
  const originalError = console.error;
  const originalExit = process.exit;
  const output = [];
  try {
    process.env.HOME = root;
    process.chdir(root);
    console.log = (...args) => output.push(args.join(' '));
    console.error = () => {};
    process.exit = (code) => { throw new Error(`unexpected exit ${code}`); };
    const { benchCommand } = require('../commands/bench');
    await benchCommand([
      'run', '--here', '--pack', 'core-v1',
      '--task', 'operator-ready-gating', '--engine', 'null', '--json',
    ]);
    assert.strictEqual(JSON.parse(output.join('\n')).engine, 'null');
  } finally {
    process.exit = originalExit;
    console.log = originalLog;
    console.error = originalError;
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  }
});
