'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('transactions accepts a limit of one and sends it in the request', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-limit-one-'));
  const previousHome = process.env.HOME;
  const previousCwd = process.cwd();
  process.env.HOME = home;
  process.chdir(home);

  try {
    const { transactionsCommand } = require('../commands/transactions');
    const requests = [];
    const output = [];
    const errors = [];
    const code = await transactionsCommand(['--limit', '1', '--json'], {
      loadCredentials: () => ({ token: 'test-login' }),
      apiRequestJson: async (pathname) => {
        requests.push(pathname);
        return { ok: true, status: 200, data: { transactions: [], count: 0, sources: {} } };
      },
      log: (line) => output.push(String(line)),
      err: (line) => errors.push(String(line)),
    });

    assert.equal(code, 0, [...errors, ...output].join('\n'));
    assert.equal(requests.length, 1, 'the minimum valid limit must reach the request');
    assert.equal(new URL(requests[0], 'https://example.invalid').searchParams.get('limit'), '1');
  } finally {
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
