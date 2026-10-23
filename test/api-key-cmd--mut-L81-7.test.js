'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { apiKeyCommand } = require('../commands/api-key');

test('create shows the original key when a replacement key is also returned', async () => {
  const stdout = [];
  const stderr = [];
  const code = await apiKeyCommand(['create', 'cli'], {
    loadCredentials: () => ({ token: 'tok' }),
    apiRequestJson: async () => ({
      ok: true,
      status: 200,
      data: { api_key: 'primary-key', new_api_key: 'secondary-key' },
    }),
    log: (line) => stdout.push(String(line)),
    err: (line) => stderr.push(String(line)),
  });

  assert.equal(code, 0);
  assert.deepEqual(stderr, []);
  assert.deepEqual(stdout, [
    'store this key now; it will not be shown again.\nprimary-key',
  ]);
});
