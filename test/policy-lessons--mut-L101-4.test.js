const test = require('node:test');
const assert = require('node:assert/strict');
const { mineProofPolicy } = require('../lib/policy-lessons');

test('zero orb window days falls back to default window', () => {
  const mined = mineProofPolicy(
    { receipts: [], episodes: [], scorecards: [] },
    { orbWindowDays: 0, now: new Date('2026-06-10T00:00:00Z') },
  );

  assert.strictEqual(mined.stats.scorecards.orb.window_days, 7);
});
