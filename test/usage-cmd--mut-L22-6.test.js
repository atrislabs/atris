'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { usageCommand } = require('../commands/usage');

test('usage treats a text response as having no recorded usage', async () => {
  const output = [];
  const code = await usageCommand([], {
    loadCredentials: () => ({ token: 'test-token' }),
    apiRequestJson: async () => ({ ok: true, status: 200, data: 'temporarily unavailable' }),
    log: (line) => output.push(String(line)),
    err: (line) => assert.fail(String(line)),
  });

  assert.equal(code, 0);
  assert.match(output.join('\n'), /no usage recorded\./);
});
