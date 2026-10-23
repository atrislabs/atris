'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { stampIso } = require('../lib/wish-store');

// stampIso reads the clock with a bare `new Date()`, so pin the clock to a
// fixed instant for every exact-value assert and restore it afterwards.
function withFixedClock(ms, fn) {
  const RealDate = global.Date;
  class FixedDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(ms);
      else super(...args);
    }
    static now() {
      return ms;
    }
  }
  global.Date = FixedDate;
  try {
    return fn();
  } finally {
    global.Date = RealDate;
  }
}

test('stampIso returns a UTC ISO string with milliseconds and a Z suffix', () => {
  const out = stampIso();
  assert.strictEqual(typeof out, 'string');
  assert.match(out, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.strictEqual(new Date(out).toISOString(), out);
});

test('stampIso formats a fixed instant exactly', () => {
  const out = withFixedClock(Date.UTC(2026, 0, 2, 3, 4, 5, 678), () => stampIso());
  assert.strictEqual(out, '2026-01-02T03:04:05.678Z');
});

test('stampIso handles the epoch and zero-pads small milliseconds', () => {
  assert.strictEqual(withFixedClock(0, () => stampIso()), '1970-01-01T00:00:00.000Z');
  assert.strictEqual(withFixedClock(5, () => stampIso()), '1970-01-01T00:00:00.005Z');
});

test('stampIso keeps the last millisecond of a leap day and rolls over after it', () => {
  const leapEnd = Date.UTC(2024, 1, 29, 23, 59, 59, 999);
  assert.strictEqual(withFixedClock(leapEnd, () => stampIso()), '2024-02-29T23:59:59.999Z');
  assert.strictEqual(withFixedClock(leapEnd + 1, () => stampIso()), '2024-03-01T00:00:00.000Z');
});

test('stampIso ignores any arguments and reads only the clock', () => {
  const ms = Date.UTC(2025, 5, 15, 12, 0, 0, 1);
  const out = withFixedClock(ms, () => stampIso('1999-12-31T00:00:00.000Z', 42));
  assert.strictEqual(out, '2025-06-15T12:00:00.001Z');
});

test('stampIso throws a RangeError when the clock reads an invalid time', () => {
  assert.throws(() => withFixedClock(NaN, () => stampIso()), RangeError);
});

test('the fixed-clock helper puts the real Date back, even after a throw', () => {
  const RealDate = global.Date;
  withFixedClock(0, () => stampIso());
  assert.strictEqual(global.Date, RealDate);
  assert.throws(() => withFixedClock(NaN, () => stampIso()), RangeError);
  assert.strictEqual(global.Date, RealDate);
});
