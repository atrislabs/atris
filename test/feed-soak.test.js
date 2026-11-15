'use strict';

// The soak run as a test: 200 rounds of the feed against a stand-in model
// that sometimes fails and is sometimes slow, with a restart in the middle.

const test = require('node:test');
const assert = require('node:assert/strict');
const { runSoak } = require('../scripts/feed-soak');

test('soak: 200 rounds with a failing, slow model and a restart leave no copies, nothing stuck, and an empty line', async () => {
  const summary = await runSoak({ rounds: 200, seed: 11 });
  assert.deepEqual(summary.failures, []);
  assert.ok(summary.counts.restarts === 1);
  assert.ok(summary.counts.failedTurns > 0, 'the stand-in model did fail');
});
