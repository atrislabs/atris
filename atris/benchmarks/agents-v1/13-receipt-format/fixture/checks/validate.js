'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isEmail } = require('../validate');

test('accepts a normal address', () => {
  assert.equal(isEmail('team@example.com'), true);
});

test('rejects missing domain', () => {
  assert.equal(isEmail('team@'), false);
});
