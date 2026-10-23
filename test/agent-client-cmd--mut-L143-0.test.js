'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { agentClientCommand } = require('../commands/agent-client');

test('revoke JSON preserves response fields while removing the client secret', async () => {
  const output = [];
  const errors = [];
  const code = await agentClientCommand(['revoke', 'atc_test123', '--json'], {
    log: (line) => output.push(line),
    err: (line) => errors.push(line),
    readActiveCredentials: () => null,
    ensureValidCredentials: async () => ({ credentials: { token: 'human-token' }, user: null }),
    apiRequestJson: async () => ({
      ok: true,
      status: 200,
      data: { name: 'test bot', client_secret: 'must-stay-private' },
    }),
  });

  assert.equal(code, 0);
  assert.deepEqual(errors, []);
  assert.deepEqual(output, [
    '{"ok":true,"client_id":"atc_test123","revoked":true,"name":"test bot"}',
  ]);
});
