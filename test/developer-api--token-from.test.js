'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { tokenFrom } = require('../lib/developer-api');

test('tokenFrom returns the token from a creds object', () => {
  assert.strictEqual(tokenFrom({ token: 'abc123' }), 'abc123');
});

test('tokenFrom trims whitespace around the token', () => {
  assert.strictEqual(tokenFrom({ token: '  abc123  ' }), 'abc123');
});

test('tokenFrom returns empty string when creds are missing or not an object', () => {
  assert.strictEqual(tokenFrom(null), '');
  assert.strictEqual(tokenFrom(undefined), '');
  assert.strictEqual(tokenFrom('abc123'), '');
  assert.strictEqual(tokenFrom(42), '');
});

test('tokenFrom returns empty string when token is not a usable string', () => {
  assert.strictEqual(tokenFrom({}), '');
  assert.strictEqual(tokenFrom({ token: 123 }), '');
  assert.strictEqual(tokenFrom({ token: null }), '');
  assert.strictEqual(tokenFrom({ token: '   ' }), '');
});
