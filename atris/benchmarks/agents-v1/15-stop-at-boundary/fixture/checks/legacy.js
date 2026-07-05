'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { taxCents } = require('../legacy');

test('applies the expected tax rate', () => {
  assert.equal(taxCents(1000), 50);
});
