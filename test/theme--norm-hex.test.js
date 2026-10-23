'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { normHex } = require('../lib/theme');

test('normHex turns a normal hex color into uppercase #RRGGBB', () => {
  assert.strictEqual(normHex('#00a88f'), '#00A88F');
  assert.strictEqual(normHex('f59e0b'), '#F59E0B');
  assert.strictEqual(normHex('#FFFFFF'), '#FFFFFF');
});

test('normHex expands a three digit hex and ignores surrounding space', () => {
  assert.strictEqual(normHex('#abc'), '#AABBCC');
  assert.strictEqual(normHex('  #0f0  '), '#00FF00');
});

test('normHex returns null for empty or invalid color', () => {
  assert.strictEqual(normHex(''), null);
  assert.strictEqual(normHex(null), null);
  assert.strictEqual(normHex('not-a-color'), null);
  assert.strictEqual(normHex('#gg0000'), null);
  assert.strictEqual(normHex('#12345'), null);
});
