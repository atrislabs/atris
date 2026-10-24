'use strict';
require('./helpers/clean-temp');

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('show tells a signed-out user how to log in', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'avail-signed-out-'));
  const originalEnv = { ...process.env };
  const originalCwd = process.cwd();
  const originalError = console.error;
  const originalLog = console.log;
  const originalExit = process.exit;
  const errors = [];
  const exitSignal = new Error('exit intercepted');
  let exitCode;
  try {
    for (const key of Object.keys(process.env)) delete process.env[key];
    process.env.HOME = home;
    process.chdir(home);
    console.error = (...args) => errors.push(args.join(' '));
    console.log = () => {};
    process.exit = code => { exitCode = code; throw exitSignal; };
    const { availCommand } = require('../commands/avail');
    await assert.rejects(availCommand(['show']), error => error === exitSignal);
    assert.equal(exitCode, 1);
    assert.match(errors.join('\n'), /atris login/i);
    assert.doesNotMatch(errors.join('\n'), /not_logged_in/);
  } finally {
    console.error = originalError;
    console.log = originalLog;
    process.exit = originalExit;
    process.chdir(originalCwd);
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, originalEnv);
  }
});
