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

// Real history rows name the APPROVER in `actor` and the work only by task
// id. Trust must follow the builder of that task, found through the episode
// log, or every builder stays "still earning trust" forever.
function approvedHistoryRoot({ builder, approver, passes, failures = 0 }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-trust-builder-'));
  const state = path.join(root, '.atris', 'state');
  fs.mkdirSync(state, { recursive: true });
  const episodes = [];
  const receiptRows = [];
  for (let i = 0; i < passes + failures; i += 1) {
    const taskId = `task-${i}`;
    episodes.push({ task_id: taskId, state: { claimed_by: null, metadata: { built_by: builder } } });
    receiptRows.push({
      source_task_id: taskId,
      source_episode_id: `ep-${i}`,
      actor: approver,
      outcome: i < passes ? 'accepted' : 'rejected',
      accepted_at: new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString(),
    });
  }
  fs.writeFileSync(path.join(state, 'career_xp_receipts.jsonl'), `${receiptRows.map(JSON.stringify).join('\n')}\n`);
  fs.writeFileSync(path.join(state, 'scorecards.jsonl'), '');
  fs.writeFileSync(path.join(state, 'task_episodes.jsonl'), `${episodes.map(JSON.stringify).join('\n')}\n`);
  return root;
}

test('trust is keyed by the builder of the approved work, never the approver', () => {
  const root = approvedHistoryRoot({ builder: 'alpha-scout', approver: 'keshavrao', passes: 12 });
  assert.equal(computeTrustTier('alpha-scout', root), 'trusted');
  // The approver did not build anything here; approving earns no trust.
  assert.equal(computeTrustTier('keshavrao', root), 'probation');
});

test('a stamped builder on a history row wins over the task lookup', () => {
  const root = approvedHistoryRoot({ builder: 'someone-else', approver: 'keshavrao', passes: 0 });
  const state = path.join(root, '.atris', 'state');
  const rows = Array.from({ length: 6 }, (_, i) => ({ builder: 'wiki-miner', actor: 'keshavrao', outcome: 'accepted', source_episode_id: `s-${i}` }));
  fs.writeFileSync(path.join(state, 'career_xp_receipts.jsonl'), `${rows.map(JSON.stringify).join('\n')}\n`);
  assert.equal(computeTrustTier('wiki-miner', root), 'standard');
});

test('a receipt and a scorecard for the same review episode count once', () => {
  const root = approvedHistoryRoot({ builder: 'executor', approver: 'keshavrao', passes: 9 });
  const state = path.join(root, '.atris', 'state');
  // Nine receipts plus nine scorecards for the same nine episodes is still 9 outcomes, not 18.
  const scorecards = Array.from({ length: 9 }, (_, i) => ({ task_id: `task-${i}`, source_episode_id: `ep-${i}`, actor: 'keshavrao', rl_label: 'accepted' }));
  fs.writeFileSync(path.join(state, 'scorecards.jsonl'), `${scorecards.map(JSON.stringify).join('\n')}\n`);
  assert.equal(computeTrustTier('executor', root), 'standard');
});

test('the landing gate asks about the builder (metadata.built_by), not the approver', () => {
  const { evaluateAutoAccept } = require('../lib/auto-accept-certified');
  const root = approvedHistoryRoot({ builder: 'alpha-scout', approver: 'keshavrao', passes: 12 });
  fs.mkdirSync(path.join(root, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(root, 'lib', 'x.js'), 'module.exports = {};\n');
  const task = {
    id: 'live-1',
    display_id: 'OBL-LIVE',
    status: 'review',
    tag: 'online-learning',
    claimed_by: null,
    workspace_root: root,
    metadata: {
      approval_status: 'pending',
      built_by: 'alpha-scout',
      agent_reviewed_by: 'alpha-scout',
      latest_agent_proof: '`node --check lib/x.js` passed (exit 0)',
      verify: 'node --check lib/x.js',
    },
    review: { approval_status: 'pending', proof: '`node --check lib/x.js` passed (exit 0)' },
    events: [{ event_type: 'proof_ready', actor: 'alpha-scout' }],
  };
  const trusted = evaluateAutoAccept(task, { acceptAll: true, executeVerify: false });
  assert.notEqual(trusted.reason, 'probation_needs_review');
  assert.equal(trusted.eligible, true);

  const stranger = evaluateAutoAccept({ ...task, metadata: { ...task.metadata, built_by: 'brand-new-member' }, events: [{ event_type: 'proof_ready', actor: 'brand-new-member' }] }, { acceptAll: true, executeVerify: false });
  assert.equal(stranger.reason, 'probation_needs_review');
});
