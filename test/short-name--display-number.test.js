'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { displayNumber } = require('../lib/short-name');

test('displayNumber keeps a positive whole number', () => {
  assert.strictEqual(displayNumber(1), 1);
  assert.strictEqual(displayNumber(7), 7);
  assert.strictEqual(displayNumber('12'), 12);
});

test('displayNumber drops zero, negatives, and fractions', () => {
  assert.strictEqual(displayNumber(0), 0);
  assert.strictEqual(displayNumber(-3), 0);
  assert.strictEqual(displayNumber(1.5), 0);
  assert.strictEqual(displayNumber(Number.POSITIVE_INFINITY), 0);
});

test('displayNumber returns zero for empty or unreadable values', () => {
  assert.strictEqual(displayNumber(''), 0);
  assert.strictEqual(displayNumber(null), 0);
  assert.strictEqual(displayNumber(undefined), 0);
  assert.strictEqual(displayNumber('nope'), 0);
});
