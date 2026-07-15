'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { computeTrustTier } = require('../lib/trust-tiers');

function historyRoot(receipts, scorecards = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-trust-tiers-'));
  const state = path.join(root, '.atris', 'state');
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, 'career_xp_receipts.jsonl'), `${receipts.map(JSON.stringify).join('\n')}${receipts.length ? '\n' : ''}`);
  fs.writeFileSync(path.join(state, 'scorecards.jsonl'), `${scorecards.map(JSON.stringify).join('\n')}${scorecards.length ? '\n' : ''}`);
  return root;
}

function receipts(actor, passes, failures) {
  return [
    ...Array.from({ length: passes }, () => ({ claimed_by: actor, outcome: 'accepted' })),
    ...Array.from({ length: failures }, () => ({ claimed_by: actor, outcome: 'rejected' })),
  ];
}

test('computeTrustTier applies outcome count and pass-rate boundaries', () => {
  assert.equal(computeTrustTier('member', historyRoot(receipts('member', 4, 0))), 'probation');
  assert.equal(computeTrustTier('member', historyRoot(receipts('member', 4, 1))), 'standard');
  assert.equal(computeTrustTier('member', historyRoot(receipts('member', 7, 3))), 'standard');
  assert.equal(computeTrustTier('member', historyRoot(receipts('member', 9, 1))), 'trusted');
});

test('computeTrustTier groups scorecard engine outcomes and uses only the last 20', () => {
  const olderFailures = Array.from({ length: 5 }, () => ({ metadata: { executed_by: 'codex' }, verify_passed: false }));
  const latestPasses = Array.from({ length: 20 }, () => ({ metadata: { executed_by: 'codex' }, verify_passed: true }));
  const root = historyRoot([], [...olderFailures, ...latestPasses]);
  assert.equal(computeTrustTier('CODEX', root), 'trusted');
  assert.equal(computeTrustTier('unknown', root), 'probation');
});

test('computeTrustTier falls back to probation for missing or corrupt history', () => {
  const missing = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-trust-tiers-missing-'));
  assert.equal(computeTrustTier('member', missing), 'probation');

  const corrupt = historyRoot(receipts('member', 10, 0));
  fs.appendFileSync(path.join(corrupt, '.atris', 'state', 'scorecards.jsonl'), '{broken\n');
  assert.equal(computeTrustTier('member', corrupt), 'probation');
});
