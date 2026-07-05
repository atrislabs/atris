'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { applyDelta } = require('../tally');

test('applies the requested delta', () => {
  assert.equal(applyDelta(10, 5), 15);
  assert.equal(applyDelta(10, -3), 7);
});
