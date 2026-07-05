'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { totalCents } = require('../cart');

test('totals price by quantity', () => {
  assert.equal(totalCents([
    { priceCents: 250, quantity: 2 },
    { priceCents: 125, quantity: 3 },
  ]), 875);
});
