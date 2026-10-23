'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { newRunToken } = require('../lib/member-progress');

test('newRunToken needs no input and returns a nonempty eight-byte hex token', () => {
  const token = newRunToken();

  assert.strictEqual(typeof token, 'string');
  assert.notStrictEqual(token, '');
  assert.strictEqual(token.length, 16);
  assert.match(token, /^[0-9a-f]{16}$/);
  assert.strictEqual(Buffer.from(token, 'hex').length, 8);
});

test('newRunToken generates fresh tokens across consecutive calls', () => {
  const tokens = Array.from({ length: 32 }, () => newRunToken());

  for (const token of tokens) {
    assert.match(token, /^[0-9a-f]{16}$/);
  }
  assert.strictEqual(new Set(tokens).size, tokens.length);
});
