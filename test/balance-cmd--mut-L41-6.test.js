'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { balanceCommand } = require('../commands/balance');

test('balance JSON errors report the numeric response status', async () => {
  const output = [];
  const errors = [];
  const exitCode = await balanceCommand(['--json'], {
    loadCredentials: () => ({ token: 'test-token' }),
    apiRequestJson: async () => ({ ok: false, error: 'access denied', status: 403 }),
    log: (line) => output.push(line),
    err: (line) => errors.push(line),
  });

  assert.equal(exitCode, 1);
  assert.deepEqual(output, ['{"ok":false,"error":"access denied","status":403}']);
  assert.deepEqual(errors, []);
});
