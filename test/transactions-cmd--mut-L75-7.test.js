'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { transactionsCommand } = require('../commands/transactions');

test('zero limit reports a validation error', async () => {
  const errors = [];
  const code = await transactionsCommand(['--limit', '0'], {
    loadCredentials: () => ({ token: 'test-token' }),
    apiRequestJson: async () => ({
      ok: true,
      status: 200,
      data: { transactions: [], sources: {} },
    }),
    log: () => {},
    err: (message) => errors.push(String(message)),
  });

  assert.match(errors.join('\n'), /--limit/);
  assert.strictEqual(code, 1);
});
