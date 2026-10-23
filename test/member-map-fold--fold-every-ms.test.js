'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { FOLD_EVERY_MS, foldDue } = require('../lib/member-map-fold');

test('FOLD_EVERY_MS: is exactly one hour in milliseconds', () => {
  assert.equal(FOLD_EVERY_MS, 60 * 60 * 1000);
  assert.equal(FOLD_EVERY_MS, 3600000);
});

test('FOLD_EVERY_MS: is a positive finite number safe for timestamp math', () => {
  assert.equal(typeof FOLD_EVERY_MS, 'number');
  assert.ok(Number.isFinite(FOLD_EVERY_MS));
  assert.ok(FOLD_EVERY_MS > 0);
});

test('FOLD_EVERY_MS: the due boundary sits exactly one interval after the last fold', () => {
  const last = Date.parse('2024-03-10T00:00:00Z');
  assert.equal(foldDue(new Date(last).toISOString(), last + FOLD_EVERY_MS), true);
  assert.equal(foldDue(new Date(last).toISOString(), last + FOLD_EVERY_MS - 1), false);
  assert.equal(foldDue(new Date(last).toISOString(), last + 2 * FOLD_EVERY_MS), true);
});

test('FOLD_EVERY_MS: an empty or unparsable last fold is always due', () => {
  const now = Date.parse('2024-03-10T00:00:00Z');
  assert.equal(foldDue('', now), true);
  assert.equal(foldDue(null, now), true);
  assert.equal(foldDue('not-a-date', now), true);
});
