'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isFresh } = require('../token');

test('token issued now is fresh', () => {
  assert.equal(isFresh(Date.now()), true);
});
