'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { lineTotal } = require('../order');

test('multiplies quantity by unit price', () => {
  assert.equal(lineTotal(3, 250), 750);
});

test('handles a single item', () => {
  assert.equal(lineTotal(1, 999), 999);
});
