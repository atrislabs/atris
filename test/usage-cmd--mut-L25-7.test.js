'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { usageCommand } = require('../commands/usage');

test('usage identifies an agent when only its id is supplied', async () => {
  const lines = [];
  await usageCommand([], {
    loadCredentials: () => ({ token: 'test-token' }),
    apiRequestJson: async () => ({
      ok: true,
      status: 200,
      data: { agent_id: 'agent-1', credits_used: 120 },
    }),
    log: (line) => lines.push(String(line)),
    err: (line) => lines.push(String(line)),
  });
  assert.match(lines.join('\n'), /agent-1/);
});
