'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { add } = require('../math');
const { greeting } = require('../message');

test('resolved behavior combines both sides', () => {
  assert.equal(add(2, 3), 5);
  assert.equal(add('2', '3'), 5);
  assert.equal(greeting(' ada '), 'hello ADA');
});
