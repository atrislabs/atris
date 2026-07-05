'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { takeFirst } = require('../src/range');

test('takes exactly the requested number of items', () => {
  assert.deepEqual(takeFirst(['a', 'b', 'c'], 2), ['a', 'b']);
});
