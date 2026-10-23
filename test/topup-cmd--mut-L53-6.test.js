'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('failed purchase JSON retains the HTTP status code', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-purchase-status-'));
  const previousHome = process.env.HOME;
  const previousCwd = process.cwd();
  process.env.HOME = home;
  process.chdir(home);
  try {
    const { topupCommand } = require('../commands/topup');
    const output = [];
    await topupCommand(['25', '--json'], {
      loadCredentials: () => ({ token: 'test-token' }),
      apiRequestJson: async () => ({ ok: false, status: 503, error: 'Service unavailable' }),
      log: (line) => output.push(String(line)),
      err: () => {},
    });
    assert.strictEqual(JSON.parse(output.join('')).status, 503);
  } finally {
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
