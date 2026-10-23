'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spokenHours } = require('../commands/spaceship');

test('zero hours uses the default spoken duration', () => {
  assert.equal(spokenHours('0'), '4 hours');
});
