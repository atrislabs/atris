'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { transactionsCommand } = require('../commands/transactions');

test('the help flag alone shows usage without a login', async () => {
  const output = [];
  await transactionsCommand(['--help'], {
    loadCredentials: () => null,
    log: (line) => output.push(String(line)),
    err: () => {},
  });
  assert.match(output.join('\n'), /\busage:/i);
});
