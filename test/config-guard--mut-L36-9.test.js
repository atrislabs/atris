'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { plantsPersistence } = require('../lib/config-guard');

test('empty content does not plant persistence', () => {
  assert.equal(plantsPersistence(''), false);
});
