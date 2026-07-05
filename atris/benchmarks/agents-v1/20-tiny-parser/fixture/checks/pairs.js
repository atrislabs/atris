'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parsePairs } = require('../pairs');

test('parses two keys', () => {
  assert.deepEqual(parsePairs('host=localhost\nport=8080\n'), {
    host: 'localhost',
    port: '8080',
  });
});

test('skips comments and blanks', () => {
  assert.deepEqual(parsePairs('# note\n\nmode=safe\n'), { mode: 'safe' });
});

test('keeps extra equals in the value', () => {
  assert.deepEqual(parsePairs('note=hello=world\n'), { note: 'hello=world' });
});
