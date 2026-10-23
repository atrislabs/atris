'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { isDue } = require('../lib/campaign-schedule');

// Fixed epoch ms so the result never depends on the real clock or time zone.
// 2026-10-15T08:00:00Z and one minute before it.
const NEXT = Date.UTC(2026, 9, 15, 8, 0, 0);
const BEFORE = NEXT - 60000;
const AFTER = NEXT + 60000;

test('isDue is true once now reaches next_at, false before', () => {
  const schedule = { next_at: NEXT };
  assert.equal(isDue(schedule, AFTER), true);
  assert.equal(isDue(schedule, BEFORE), false);
});

test('isDue treats the exact next_at minute as due', () => {
  assert.equal(isDue({ next_at: NEXT }, NEXT), true);
});

test('isDue is false for empty or shapeless schedules', () => {
  assert.equal(isDue(null, AFTER), false);
  assert.equal(isDue(undefined, AFTER), false);
  assert.equal(isDue({}, AFTER), false);
  assert.equal(isDue({ next_at: Number.NaN }, AFTER), false);
});
