'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('a request error without a message prints a readable failure', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-empty-error-'));
  const previousHome = process.env.HOME;
  const previousCwd = process.cwd();
  process.env.HOME = home;
  process.chdir(home);
  try {
    const { topupCommand } = require('../commands/topup');
    const output = [];
    await topupCommand(['10', '--json'], {
      loadCredentials: () => ({ token: 'test-token' }),
      apiRequestJson: async () => { throw new Error(); },
      log: (line) => output.push(String(line)),
      err: () => {},
    });
    assert.match(JSON.parse(output.join('')).error, /failed/);
  } finally {
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
