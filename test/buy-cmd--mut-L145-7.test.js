'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buyCommand } = require('../commands/buy');

test('buy approve preserves the message when more input is needed', async () => {
  const stdout = [];
  const stderr = [];
  const code = await buyCommand(['approve', 'ord_example'], {
    loadCredentials: () => ({ token: 'test-token' }),
    now: () => 0,
    apiRequestJson: async () => ({
      ok: true,
      data: {
        status: 'needs_input',
        message: 'Choose a delivery address.',
        fields: ['address'],
      },
    }),
    log: (text) => stdout.push(text),
    err: (text) => stderr.push(text),
  });

  assert.equal(code, 0);
  assert.deepEqual(stderr, []);
  assert.deepEqual(stdout, [
    'Choose a delivery address.\nNeeded: address\nNothing was charged.',
  ]);
});
