const { test } = require('node:test');
const assert = require('node:assert');
const { startOfToday } = require('../lib/agent-today');

// Fixed dates only. Built with local-time constructors, so the expected
// values line up with the local-time setHours() inside startOfToday.
function localParts(d) {
  return [
    d.getFullYear(),
    d.getMonth(),
    d.getDate(),
    d.getHours(),
    d.getMinutes(),
    d.getSeconds(),
    d.getMilliseconds(),
  ];
}

test('startOfToday rounds a mid-day time down to local midnight of the same day', () => {
  const noon = new Date(2026, 9, 23, 15, 42, 7, 519);
  const start = startOfToday(noon);

  assert.deepStrictEqual(localParts(start), [2026, 9, 23, 0, 0, 0, 0]);
  assert.strictEqual(start.getTime(), new Date(2026, 9, 23).getTime());
});

test('startOfToday keeps the same day for a time just before midnight and does not mutate its input', () => {
  const lastMoment = new Date(2026, 9, 23, 23, 59, 59, 999);
  const before = lastMoment.getTime();

  const start = startOfToday(lastMoment);

  assert.deepStrictEqual(localParts(start), [2026, 9, 23, 0, 0, 0, 0]);
  assert.strictEqual(lastMoment.getTime(), before, 'input Date must not be changed');
  assert.notStrictEqual(start, lastMoment, 'should return a new Date, not the same object');
});

test('startOfToday accepts a local date-time string and a timestamp', () => {
  const fromString = startOfToday('2026-10-23T18:00:00');
  assert.deepStrictEqual(localParts(fromString), [2026, 9, 23, 0, 0, 0, 0]);

  const fromNumber = startOfToday(new Date(2026, 9, 23, 9, 5).getTime());
  assert.deepStrictEqual(localParts(fromNumber), [2026, 9, 23, 0, 0, 0, 0]);
});

test('startOfToday returns an invalid Date instead of throwing for unparseable input', () => {
  let result;
  assert.doesNotThrow(() => {
    result = startOfToday('not a real date');
  });

  assert.ok(result instanceof Date);
  assert.ok(Number.isNaN(result.getTime()), 'expected an Invalid Date');
});
