'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { summarizeRuns } = require('../lib/roster-runs');

test('summarizeRuns counts outcomes, handovers, tokens, and the even median', () => {
  const runs = [
    { outcome: 'landed', seconds: 120, tokens: 100 },
    { outcome: 'failed', seconds: 60, tokens: 25, handed_over_to: 'next' },
    { outcome: 'stalled', seconds: 300, tokens: 0 },
    { outcome: 'credit out', seconds: 180, handed_over_to: 'backup' },
  ];
  const before = JSON.stringify(runs);

  assert.deepStrictEqual(summarizeRuns(runs, { days: 3 }), {
    days: 3,
    runs: 4,
    landed: 1,
    failed: 1,
    stalled: 1,
    credit_out: 1,
    handed_over: 2,
    median_seconds: 150,
    tokens: 125,
    text: 'last 3 days: 4 runs, 1 landed, 1 stalled, 1 failed, 1 credit out, median 3 min',
  });
  assert.strictEqual(JSON.stringify(runs), before);
});

test('summarizeRuns formats a single run and preserves reported zero tokens', () => {
  assert.deepStrictEqual(summarizeRuns([
    { outcome: 'landed', seconds: 30, tokens: 0 },
  ], { days: 1 }), {
    days: 1,
    runs: 1,
    landed: 1,
    failed: 0,
    stalled: 0,
    credit_out: 0,
    handed_over: 0,
    median_seconds: 30,
    tokens: 0,
    text: 'last 1 day: 1 run, 1 landed, median 30s',
  });
});

test('summarizeRuns omits unavailable tokens and ignores invalid durations', () => {
  assert.deepStrictEqual(summarizeRuns([
    { outcome: 'failed', seconds: -1, tokens: NaN },
    { outcome: 'failed', seconds: Infinity, tokens: Infinity },
    { outcome: 'failed', tokens: '100' },
  ]), {
    days: 7,
    runs: 3,
    landed: 0,
    failed: 3,
    stalled: 0,
    credit_out: 0,
    handed_over: 0,
    median_seconds: null,
    text: 'last 7 days: 3 runs, 3 failed',
  });
});

test('summarizeRuns returns null for empty or absent runs', () => {
  assert.strictEqual(summarizeRuns([]), null);
  assert.strictEqual(summarizeRuns(null), null);
  assert.strictEqual(summarizeRuns(), null);
});
