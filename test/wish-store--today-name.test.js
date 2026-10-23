'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { todayName } = require('../lib/wish-store');

// Local calendar constructors keep these expectations independent of time zone.
test('todayName formats a supplied local date and ignores its time', () => {
  assert.strictEqual(todayName(new Date(2025, 10, 23, 18, 45, 12)), '2025-11-23');
  assert.strictEqual(todayName(new Date(2025, 0, 2, 0, 0, 0)), '2025-01-02');
});

test('todayName handles leap day and both ends of a calendar year', () => {
  assert.strictEqual(todayName(new Date(2024, 1, 29)), '2024-02-29');
  assert.strictEqual(todayName(new Date(2024, 11, 31)), '2024-12-31');
  assert.strictEqual(todayName(new Date(2025, 0, 1)), '2025-01-01');
});

test('todayName exposes invalid dates and rejects non-date inputs', () => {
  assert.strictEqual(todayName(new Date(NaN)), 'NaN-NaN-NaN');
  assert.throws(() => todayName(null), TypeError);
  assert.throws(() => todayName(''), TypeError);
});
