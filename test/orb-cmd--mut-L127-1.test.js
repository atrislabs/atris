'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runOrb } = require('../commands/orb');

test('orb rejects an explicit pick beyond the available moves', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orb-explicit-pick-'));
  const previousCwd = process.cwd();
  const previousEnv = { ...process.env };
  const previousLog = console.log;
  const previousError = console.error;
  const errors = [];

  try {
    for (const key of Object.keys(process.env)) delete process.env[key];
    process.env.HOME = root;
    process.env.PATH = '';
    process.chdir(root);
    console.log = () => {};
    console.error = (...args) => errors.push(args.join(' '));

    const code = await runOrb(['--once', '--pick', '99']);

    assert.deepEqual(errors, [
      'orb warning: engine binary "claude" is missing from PATH; picks will fail until it is installed.',
      'orb: no move 99. Pick 1-4.',
    ]);
    assert.equal(code, 2);
  } finally {
    console.log = previousLog;
    console.error = previousError;
    process.chdir(previousCwd);
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, previousEnv);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
