'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isNonInteractive } = require('../lib/noninteractive');

test('piped input enables noninteractive mode without flags or environment overrides', (t) => {
  for (const name of ['ATRIS_NONINTERACTIVE', 'ATRIS_NO_INTERACTIVE']) {
    const previous = process.env[name];
    delete process.env[name];
    t.after(() => {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    });
  }
  for (const [stream, value] of [[process.stdin, false], [process.stdout, true]]) {
    const descriptor = Object.getOwnPropertyDescriptor(stream, 'isTTY');
    Object.defineProperty(stream, 'isTTY', { configurable: true, value });
    t.after(() => {
      if (descriptor) Object.defineProperty(stream, 'isTTY', descriptor);
      else delete stream.isTTY;
    });
  }
  assert.strictEqual(isNonInteractive([]), true);
});
