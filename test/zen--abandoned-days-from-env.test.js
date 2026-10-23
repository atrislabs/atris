'use strict';

// abandonedDaysFromEnv reads ATRIS_ZEN_ABANDONED_DAYS and falls back to the
// default of 3 days whenever the value is missing or not a finite number. It
// only reads the environment, so these tests set and restore that one variable.

const { test } = require('node:test');
const assert = require('node:assert');
const { ABANDONED_DAYS, abandonedDaysFromEnv } = require('../lib/zen');

const KEY = 'ATRIS_ZEN_ABANDONED_DAYS';

// Runs fn with the variable set to value (or unset when value is undefined),
// then puts back whatever was there before.
function withAbandonedEnv(value, fn) {
  const before = process.env[KEY];
  if (value === undefined) delete process.env[KEY];
  else process.env[KEY] = value;
  try {
    return fn();
  } finally {
    if (before === undefined) delete process.env[KEY];
    else process.env[KEY] = before;
  }
}

test('unset env var gives the default of 3 days', () => {
  withAbandonedEnv(undefined, () => {
    assert.strictEqual(ABANDONED_DAYS, 3);
    assert.strictEqual(abandonedDaysFromEnv(), 3);
  });
});

test('a numeric env var is used as the day count, whole or fractional', () => {
  withAbandonedEnv('7', () => assert.strictEqual(abandonedDaysFromEnv(), 7));
  withAbandonedEnv('1.5', () => assert.strictEqual(abandonedDaysFromEnv(), 1.5));
  // Zero is a real value here, not a missing one, so it must not fall back to 3.
  withAbandonedEnv('0', () => assert.strictEqual(abandonedDaysFromEnv(), 0));
  // parseFloat reads the leading number, so padding and trailing words still count.
  withAbandonedEnv('  2 days', () => assert.strictEqual(abandonedDaysFromEnv(), 2));
});

test('empty, non-numeric, or non-finite values fall back to 3 days', () => {
  withAbandonedEnv('', () => assert.strictEqual(abandonedDaysFromEnv(), 3));
  withAbandonedEnv('abc', () => assert.strictEqual(abandonedDaysFromEnv(), 3));
  withAbandonedEnv('NaN', () => assert.strictEqual(abandonedDaysFromEnv(), 3));
  withAbandonedEnv('Infinity', () => assert.strictEqual(abandonedDaysFromEnv(), 3));
});
