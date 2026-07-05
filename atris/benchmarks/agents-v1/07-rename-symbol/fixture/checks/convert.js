'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { toMeters } = require('../convert');

test('converts km to meters', () => {
  assert.equal(toMeters(2, 'km'), 2000);
});
