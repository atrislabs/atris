'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { shippingCents } = require('../shipping');

test('charges per ounce below the free threshold', () => {
  assert.equal(shippingCents(10, 'west'), 120);
});

test('free shipping at exactly the threshold', () => {
  assert.equal(shippingCents(16, 'west'), 0);
});
