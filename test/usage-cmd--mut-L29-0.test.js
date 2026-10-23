'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { usageCommand } = require('../commands/usage');

function runUsage(data) {
  const stdout = [];
  const stderr = [];
  const code = usageCommand([], {
    loadCredentials: () => ({ token: 'tok' }),
    apiRequestJson: async () => ({ ok: true, status: 200, data }),
    log: (line) => stdout.push(String(line)),
    err: (line) => stderr.push(String(line)),
  });
  return { code, stdout, stderr };
}

test('usage with an empty 200 body still prints a sentence', async () => {
  const { code, stdout } = await runUsage({});
  assert.equal(await code, 0);
  assert.match(stdout.join('\n'), /no usage recorded/);
});

test('usage with a populated 200 body prints the metric key', async () => {
  const { code, stdout } = await runUsage({ total_calls: 7 });
  assert.equal(await code, 0);
  assert.match(stdout.join('\n'), /total_calls/);
});
