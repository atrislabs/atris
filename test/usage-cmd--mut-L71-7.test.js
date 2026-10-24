'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { usageCommand } = require('../commands/usage');

test('usage reports a rejected authenticated request as an error', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-usage-rejected-'));
  const previousHome = process.env.HOME;
  const previousCwd = process.cwd();
  const previousExit = process.exit;
  const previousLog = console.log;
  const previousError = console.error;
  const output = [];
  try {
    process.env.HOME = home;
    process.chdir(home);
    process.exit = (code) => { throw new Error(`unexpected exit: ${code}`); };
    console.log = (line) => output.push(String(line));
    console.error = (line) => output.push(String(line));
    await usageCommand(['--json'], {
      loadCredentials: () => ({ token: 'expired-token' }),
      apiRequestJson: async () => ({ ok: false, status: 401, error: 'unauthorized' }),
      log: console.log,
      err: console.error,
    });
    assert.strictEqual(JSON.parse(output.join('')).ok, false);
    assert.match(JSON.parse(output.join('')).error, /unauthorized/i);
  } finally {
    process.exit = previousExit;
    console.log = previousLog;
    console.error = previousError;
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
