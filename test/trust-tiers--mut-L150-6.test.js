'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { computeTrustTier } = require('../lib/trust-tiers');

test('a receipt builder keeps credit when its task names a different builder', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-builder-credit-'));
  const state = path.join(root, '.atris', 'state');
  fs.mkdirSync(state, { recursive: true });
  const rows = Array.from({ length: 6 }, (_, i) => ({
    builder: 'original-builder',
    actor: 'reviewer',
    outcome: 'accepted',
    source_task_id: `task-${i}`,
    source_episode_id: `episode-${i}`,
    accepted_at: '2026-10-01T12:00:00.000Z',
  }));
  const episodes = rows.map(row => ({
    task_id: row.source_task_id,
    state: { claimed_by: null, metadata: { built_by: 'later-builder' } },
  }));
  fs.writeFileSync(path.join(state, 'career_xp_receipts.jsonl'), rows.map(JSON.stringify).join('\n') + '\n');
  fs.writeFileSync(path.join(state, 'task_episodes.jsonl'), episodes.map(JSON.stringify).join('\n') + '\n');
  fs.writeFileSync(path.join(state, 'scorecards.jsonl'), '');
  assert.equal(computeTrustTier('original-builder', root), 'standard');
});
