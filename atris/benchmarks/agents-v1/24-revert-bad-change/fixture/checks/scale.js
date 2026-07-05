'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { scale } = require('../scale');

test('multiplies value by factor', () => {
  assert.equal(scale(4, 3), 12);
});

test('handles zero', () => {
  assert.equal(scale(0, 9), 0);
});
