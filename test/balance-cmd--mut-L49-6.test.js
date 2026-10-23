'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { balanceCommand } = require('../commands/balance');

test('balance uses the fallback message when a request rejects with a string', async () => {
  const stdout = [];
  const stderr = [];
  const code = await balanceCommand(['--json'], {
    loadCredentials: () => ({ token: 'test-token' }),
    apiRequestJson: async () => {
      throw 'request rejected';
    },
    log: (line) => stdout.push(line),
    err: (line) => stderr.push(line),
  });

  assert.equal(code, 1);
  assert.deepEqual(stdout, ['{"ok":false,"error":"request failed"}']);
  assert.deepEqual(stderr, []);
});
