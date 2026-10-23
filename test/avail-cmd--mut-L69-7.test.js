'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseTimeToDecimal } = require('../commands/avail');

test('rejects a 24-hour time whose hour exceeds 23', () => {
  assert.throws(() => parseTimeToDecimal('24:00'), /invalid time/i);
});
