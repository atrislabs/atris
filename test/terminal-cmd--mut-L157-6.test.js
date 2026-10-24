'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { terminalAtris } = require('../commands/terminal');

test('a command split across arguments does not turn its first argument into a business', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-command-business-'));
  const originalCwd = process.cwd();
  const originalEnv = { ...process.env };
  const originalArgv = process.argv;
  const originalExit = process.exit;
  const originalLog = console.log;
  const originalError = console.error;
  const errors = [];
  const exitSignal = new Error('command exited');

  try {
    for (const key of Object.keys(process.env)) delete process.env[key];
    process.env.HOME = root;
    process.chdir(root);
    process.argv = ['node', 'atris', 'terminal', '--account', 'echo hello', 'world'];
    process.exit = () => { throw exitSignal; };
    console.log = () => {};
    console.error = (...parts) => errors.push(parts.join(' '));
    try {
      await terminalAtris();
    } catch (error) {
      if (error !== exitSignal) throw error;
    }
  } finally {
    process.chdir(originalCwd);
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, originalEnv);
    process.argv = originalArgv;
    process.exit = originalExit;
    console.log = originalLog;
    console.error = originalError;
  }

  assert.match(errors.join('\n'), /Cannot determine business/);
});
