'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { paginate } = require('../store');

test('returns exactly the requested page', () => {
  const items = ['a', 'b', 'c', 'd', 'e'];
  assert.deepEqual(paginate(items, 1, 2), ['a', 'b']);
});
