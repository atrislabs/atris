'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { computeTrustTier } = require('../lib/trust-tiers');

test('outcomes sort correctly with undated and dated records', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-tier-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const state = path.join(root, '.atris', 'state');
  fs.mkdirSync(state, { recursive: true });

  const rows = [
    { builder: 'agent', outcome: 'rejected', accepted_at: '1970-01-01T00:00:00.000Z' },
    { builder: 'agent', outcome: 'accepted' },
  ];
  for (let i = 0; i < 17; i++) {
    const min = String(i).padStart(2, '0');
    rows.push({ builder: 'agent', outcome: 'accepted', accepted_at: `2026-10-01T00:${min}:00.000Z` });
  }
  rows.push({ builder: 'agent', outcome: 'rejected', accepted_at: '2026-10-01T01:00:00.000Z' });
  rows.push({ builder: 'agent', outcome: 'rejected', accepted_at: '2026-10-01T01:01:00.000Z' });

  fs.writeFileSync(path.join(state, 'career_xp_receipts.jsonl'), `${rows.map(JSON.stringify).join('\n')}\n`);
  fs.writeFileSync(path.join(state, 'scorecards.jsonl'), '');

  assert.strictEqual(computeTrustTier('agent', root), 'standard');
});
