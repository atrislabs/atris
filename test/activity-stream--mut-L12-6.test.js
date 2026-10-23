'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const {
  buildActivityStream,
  normalizeScorecard,
} = require('../lib/activity-stream');

// A timestamp of 0 is falsy, so the reader must skip it like a missing key.
// On Node, Date.parse(0) is finite (it reads "0" as the year 2000), so a
// check that lets 0 through would emit a bogus timestamp.

test('a zero timestamp is treated as missing, not parsed', () => {
  const e = normalizeScorecard({ ts: 0, reward: 1, what_shipped: 'x' });
  assert.equal(e.ts, null);
  assert.equal(e.ms, 0);
});

test('a zero timestamp falls through to the next timestamp key', () => {
  const e = normalizeScorecard({ ts: 0, at: '2026-06-16T10:00:00Z', reward: 1 });
  assert.equal(e.ts, '2026-06-16T10:00:00Z');
  assert.equal(e.ms, Date.parse('2026-06-16T10:00:00Z'));
});

test('a row whose only timestamp is zero never reaches the feed', () => {
  const events = buildActivityStream({ scorecards: [{ ts: 0, reward: 1 }] });
  assert.equal(events.length, 0);
});
