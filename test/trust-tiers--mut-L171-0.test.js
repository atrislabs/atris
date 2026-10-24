'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { computeTrustTier } = require('../lib/trust-tiers');

test('newly accepted work refreshes a previously calculated trust tier', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-trust-refresh-'));
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  try {
    const state = path.join(root, '.atris', 'state');
    fs.mkdirSync(state, { recursive: true });
    const receipts = path.join(state, 'career_xp_receipts.jsonl');
    fs.writeFileSync(receipts, '');
    fs.writeFileSync(path.join(state, 'scorecards.jsonl'), '');
    assert.strictEqual(computeTrustTier('builder', root), 'probation');
    const rows = Array.from({ length: 10 }, (_, i) => ({
      builder: 'builder',
      outcome: 'accepted',
      source_episode_id: `review-${i}`,
      accepted_at: '2026-10-01T12:00:00.000Z',
    }));
    fs.appendFileSync(receipts, rows.map(JSON.stringify).join('\n') + '\n');
    assert.strictEqual(computeTrustTier('builder', root), 'trusted');
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
