'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { computeTrustTier } = require('../lib/trust-tiers');

test('older failures appended after recent approvals do not displace the latest twenty outcomes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-dated-outcomes-'));
  const state = path.join(root, '.atris', 'state');
  fs.mkdirSync(state, { recursive: true });
  const rows = [
    ...Array.from({ length: 20 }, (_, i) => ({
      builder: 'builder', outcome: 'accepted', source_episode_id: `recent-${i}`,
      accepted_at: '2026-10-01T12:00:00.000Z',
    })),
    ...Array.from({ length: 20 }, (_, i) => ({
      builder: 'builder', outcome: 'rejected', source_episode_id: `older-${i}`,
      accepted_at: '2026-09-01T12:00:00.000Z',
    })),
  ];
  fs.writeFileSync(path.join(state, 'career_xp_receipts.jsonl'), rows.map(JSON.stringify).join('\n') + '\n');
  fs.writeFileSync(path.join(state, 'scorecards.jsonl'), '');
  assert.strictEqual(computeTrustTier('builder', root), 'trusted');
});
