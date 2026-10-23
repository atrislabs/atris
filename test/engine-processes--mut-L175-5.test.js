'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { shortElapsed } = require('../lib/engine-processes');

test('exactly one hour is displayed in hours', () => {
  assert.equal(shortElapsed(3600), '1h');
});
