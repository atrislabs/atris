'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { apiKeyCommand } = require('../commands/api-key');

test('list reports the exact failed request response as JSON', async () => {
  const output = [];
  const errors = [];
  const exitCode = await apiKeyCommand(['list', '--json'], {
    loadCredentials: () => ({ token: 'test-token' }),
    apiRequestJson: async () => ({
      ok: false,
      status: 403,
      error: 'access denied',
    }),
    log: (message) => output.push(message),
    err: (message) => errors.push(message),
  });

  assert.deepEqual(output, ['{"ok":false,"error":"access denied","status":403}']);
  assert.deepEqual(errors, []);
  assert.equal(exitCode, 1);
});
