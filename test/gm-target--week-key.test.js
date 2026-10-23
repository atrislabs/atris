'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { weekKey } = require('../lib/gm-target');

// Every date is built from local parts so the expected key is the same in any
// time zone: weekKey reads the local calendar, and so do these.
const local = (y, m, d, h = 12, min = 0, s = 0, ms = 0) => new Date(y, m - 1, d, h, min, s, ms).getTime();

test('weekKey gives the local monday date for any day in that week', () => {
  // Monday 2026-10-19 through Sunday 2026-10-25 all belong to the week of the 19th.
  for (let day = 19; day <= 25; day += 1) {
    assert.strictEqual(weekKey(local(2026, 10, day)), '2026-10-19', `oct ${day}`);
  }
  // A Monday maps to itself, a Wednesday to the Monday before it.
  assert.strictEqual(weekKey(local(2026, 10, 19)), '2026-10-19');
  assert.strictEqual(weekKey(local(2026, 10, 21)), '2026-10-19');
});

test('weekKey rolls over at monday local midnight, not at sunday', () => {
  assert.strictEqual(weekKey(local(2026, 10, 19, 0, 0, 0, 0)), '2026-10-19');
  assert.strictEqual(weekKey(local(2026, 10, 19, 0, 0, 0, 0) - 1), '2026-10-12');
  assert.strictEqual(weekKey(local(2026, 10, 25, 23, 59, 59, 999)), '2026-10-19');
  assert.strictEqual(weekKey(local(2026, 10, 26, 0, 0, 0, 0)), '2026-10-26');
});

test('weekKey crosses month, year, and leap-day boundaries', () => {
  // Sunday 2026-11-01 still counts toward the week that began 2026-10-26.
  assert.strictEqual(weekKey(local(2026, 11, 1)), '2026-10-26');
  // Thursday 2026-01-01 belongs to the week that began Monday 2025-12-29.
  assert.strictEqual(weekKey(local(2026, 1, 1)), '2025-12-29');
  // Thursday 2024-02-29 (leap day) belongs to the week of Monday 2024-02-26.
  assert.strictEqual(weekKey(local(2024, 2, 29)), '2024-02-26');
  // Monday 2024-03-04 is the first day of the next week.
  assert.strictEqual(weekKey(local(2024, 3, 4)), '2024-03-04');
});

test('weekKey stays on the right monday across daylight saving changes', () => {
  // US clocks moved on 2026-03-08 and 2026-11-01; by-date math must not slip a day.
  assert.strictEqual(weekKey(local(2026, 3, 8)), '2026-03-02');
  assert.strictEqual(weekKey(local(2026, 3, 9)), '2026-03-09');
  assert.strictEqual(weekKey(local(2026, 11, 2)), '2026-11-02');
  assert.strictEqual(weekKey(local(2026, 11, 1, 23, 30)), '2026-10-26');
});

test('weekKey always returns a zero-padded YYYY-MM-DD string that sorts by week', () => {
  const key = weekKey(local(2026, 1, 7));
  assert.strictEqual(key, '2026-01-05');
  assert.match(key, /^\d{4}-\d{2}-\d{2}$/);

  const keys = [local(2026, 1, 1), local(2025, 12, 20), local(2026, 10, 21), local(2026, 2, 3)].map(weekKey);
  assert.deepStrictEqual(keys, ['2025-12-29', '2025-12-15', '2026-10-19', '2026-02-02']);
  assert.deepStrictEqual([...keys].sort(), ['2025-12-15', '2025-12-29', '2026-02-02', '2026-10-19']);
});

test('weekKey gives the same key for two moments in one week and different keys across weeks', () => {
  assert.strictEqual(weekKey(local(2026, 10, 20, 1)), weekKey(local(2026, 10, 24, 23)));
  assert.notStrictEqual(weekKey(local(2026, 10, 25, 23)), weekKey(local(2026, 10, 26, 1)));
});

test('weekKey on an unusable moment never yields a valid week key', () => {
  for (const bad of [NaN, 'not a date', {}]) {
    assert.doesNotMatch(weekKey(bad), /^\d{4}-\d{2}-\d{2}$/, String(bad));
  }
});
