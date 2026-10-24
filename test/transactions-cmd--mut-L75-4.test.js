'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('transactions accepts the maximum limit of 200 and sends it in the query', async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-limit-boundary-'));
  const previousHome = process.env.HOME;
  const previousCwd = process.cwd();
  process.env.HOME = scratch;
  process.chdir(scratch);

  try {
    const { transactionsCommand } = require('../commands/transactions');
    let requestedLimit;
    const output = [];
    const code = await transactionsCommand(['--limit', '200', '--json'], {
      loadCredentials: () => ({ token: 'test-login' }),
      apiRequestJson: async (pathname) => {
        requestedLimit = new URL(pathname, 'https://example.invalid').searchParams.get('limit');
        return { ok: true, status: 200, data: { transactions: [], count: 0, sources: {} } };
      },
      log: (line) => output.push(String(line)),
      err: (line) => output.push(String(line)),
    });

    assert.equal(requestedLimit, '200', 'the inclusive upper limit must reach the transaction request');
    assert.equal(code, 0, output.join('\n'));
  } finally {
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
