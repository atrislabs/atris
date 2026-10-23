'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { skillCommand } = require('../commands/skill');

test('audit reports missing target and exits with error code', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-test-'));
  const previousCwd = process.cwd();
  const previousHome = process.env.HOME;
  const previousError = console.error;
  const previousExit = process.exit;
  const errors = [];
  const exitSignal = new Error('intercepted exit');
  let exitCode;

  try {
    process.chdir(root);
    process.env.HOME = root;
    console.error = (...args) => errors.push(args.join(' '));
    process.exit = (code) => {
      exitCode = code;
      throw exitSignal;
    };

    assert.throws(
      () => skillCommand('audit', 'nonexistent-target'),
      (err) => err === exitSignal
    );
  } finally {
    process.exit = previousExit;
    console.error = previousError;
    process.chdir(previousCwd);
    process.env.HOME = previousHome || os.tmpdir();
    fs.rmSync(root, { recursive: true, force: true });
  }

  assert.strictEqual(exitCode, 1);
  assert.ok(errors.some((line) => line.includes('not found')));
});
