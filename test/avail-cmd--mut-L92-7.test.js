'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseDaysArg } = require('../commands/avail');

test('weekends selects Saturday and Sunday', () => {
  let days;
  try {
    days = parseDaysArg('weekends');
  } catch {
    // Rejected input leaves no selected days.
  }
  assert.strictEqual(days?.join(','), '5,6');
});
