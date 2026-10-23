'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { topupCommand } = require('../commands/topup');

test('topup reports the fallback error when a failed response has no error field', async () => {
  const stdout = [];
  const stderr = [];
  const code = await topupCommand(['--json'], {
    loadCredentials: () => ({ token: 'test-token' }),
    apiRequestJson: async () => ({ ok: false, status: 503 }),
    log: (line) => stdout.push(line),
    err: (line) => stderr.push(line),
  });

  assert.equal(code, 1);
  assert.deepEqual(stdout, ['{"ok":false,"error":"request failed","status":503}']);
  assert.deepEqual(stderr, []);
});
