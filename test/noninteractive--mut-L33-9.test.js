'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isNonInteractive } = require('../lib/noninteractive');

test('an interactive terminal without forced flags remains interactive', () => {
  const names = ['ATRIS_NONINTERACTIVE', 'ATRIS_NO_INTERACTIVE'];
  const saved = names.map((name) => process.env[name]);
  const stdinTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  const stdoutTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  try {
    for (const name of names) delete process.env[name];
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    assert.strictEqual(isNonInteractive([]), false);
  } finally {
    names.forEach((name, index) => {
      if (saved[index] === undefined) delete process.env[name];
      else process.env[name] = saved[index];
    });
    if (stdinTTY) Object.defineProperty(process.stdin, 'isTTY', stdinTTY);
    else delete process.stdin.isTTY;
    if (stdoutTTY) Object.defineProperty(process.stdout, 'isTTY', stdoutTTY);
    else delete process.stdout.isTTY;
  }
});
