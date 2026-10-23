const test = require('node:test');
const assert = require('node:assert');

const { localDay } = require('../lib/local-day');

function withTimezone(tz, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, 'TZ');
  const prev = process.env.TZ;
  process.env.TZ = tz;
  try {
    return fn();
  } finally {
    if (had) process.env.TZ = prev;
    else delete process.env.TZ;
  }
}

test('localDay formats a Date as YYYY-MM-DD from its local fields', () => {
  assert.strictEqual(localDay(new Date(2026, 9, 23, 12, 0, 0)), '2026-10-23');
});

test('localDay zero-pads single-digit months and days', () => {
  assert.strictEqual(localDay(new Date(2026, 0, 5, 9, 30)), '2026-01-05');
  assert.strictEqual(localDay(new Date(2026, 8, 9, 9, 30)), '2026-09-09');
});

test('localDay keeps the day at both edges of a local day', () => {
  assert.strictEqual(localDay(new Date(2026, 2, 5, 0, 0, 0, 0)), '2026-03-05');
  assert.strictEqual(localDay(new Date(2026, 2, 5, 23, 59, 59, 999)), '2026-03-05');
  assert.strictEqual(localDay(new Date(2026, 2, 6, 0, 0, 0, 0)), '2026-03-06');
});

test('localDay rolls over month, year, and leap-day boundaries', () => {
  assert.strictEqual(localDay(new Date(2026, 11, 31, 23, 59)), '2026-12-31');
  assert.strictEqual(localDay(new Date(2027, 0, 1, 0, 0)), '2027-01-01');
  assert.strictEqual(localDay(new Date(2028, 1, 29, 12, 0)), '2028-02-29');
  assert.strictEqual(localDay(new Date(2027, 1, 28, 12, 0)), '2027-02-28');
});

test('localDay accepts epoch milliseconds and non-UTC date strings', () => {
  const noon = new Date(2026, 9, 23, 12, 0, 0);
  assert.strictEqual(localDay(noon.getTime()), '2026-10-23');
  assert.strictEqual(localDay('2026-10-23T12:00:00'), '2026-10-23');
});

test('localDay with no argument returns today in local time', () => {
  const before = localDay(new Date());
  const got = localDay();
  const after = localDay(new Date());
  assert.match(got, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(got === before || got === after, `${got} not in [${before}, ${after}]`);
});

test('localDay gives the local day, not the UTC day, west of Greenwich', () => {
  // 03:00 UTC on Mar 6 is still the evening of Mar 5 in Los Angeles.
  const instant = new Date('2026-03-06T03:00:00Z');
  assert.strictEqual(instant.toISOString().slice(0, 10), '2026-03-06');
  withTimezone('America/Los_Angeles', () => {
    assert.strictEqual(localDay(instant), '2026-03-05');
  });
});

test('localDay gives the local day east of Greenwich too', () => {
  // 20:00 UTC on Mar 5 is already the morning of Mar 6 in Tokyo.
  const instant = new Date('2026-03-05T20:00:00Z');
  assert.strictEqual(instant.toISOString().slice(0, 10), '2026-03-05');
  withTimezone('Asia/Tokyo', () => {
    assert.strictEqual(localDay(instant), '2026-03-06');
  });
});

test('localDay does not mutate the Date it is given', () => {
  const d = new Date(2026, 9, 23, 18, 45, 12, 345);
  const before = d.getTime();
  localDay(d);
  assert.strictEqual(d.getTime(), before);
});

test('localDay on an invalid date does not throw and is not a real day', () => {
  const out = localDay(new Date('not a date'));
  assert.strictEqual(typeof out, 'string');
  assert.doesNotMatch(out, /^\d{4}-\d{2}-\d{2}$/);
});
