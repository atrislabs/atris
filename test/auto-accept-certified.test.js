'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { evaluateAutoAccept, parseVerifyCommand, runVerifyCommand } = require('../lib/auto-accept-certified');

function reviewTask(overrides = {}) {
  return {
    id: 'task-1',
    display_id: 'OBL-TEST',
    status: 'review',
    tag: 'self-improve',
    workspace_root: process.cwd(),
    metadata: {
      approval_status: 'pending',
      agent_certified: true,
      agent_review_pass_count: 2,
      latest_agent_proof: 'npm run test:team-overall passed; git diff --check passed',
      verify: 'npm run test:team-overall',
      ...overrides.metadata,
    },
    review: {
      approval_status: 'pending',
      agent_certified: true,
      agent_review_pass_count: 2,
      proof: 'npm run test:team-overall passed; git diff --check passed',
      ...overrides.review,
    },
    events: overrides.events || [
      { event_type: 'proof_ready', actor: 'codex' },
      { event_type: 'reviewed', actor: 'validator' },
    ],
    ...(overrides.tag ? { tag: overrides.tag } : {}),
  };
}

test('accepts certified review with two actors and meaningful proof', () => {
  const result = evaluateAutoAccept(reviewTask());
  assert.equal(result.eligible, true);
  assert.equal(result.policy, '2_actors_2_passes');
});

test('strict verify missing points agents back to review chat', () => {
  const result = evaluateAutoAccept(reviewTask({
    metadata: { verify: '' },
  }), { strictVerify: true });
  assert.equal(result.eligible, false);
  assert.equal(result.reason, 'strict_verify_missing');
  assert.match(result.next_action, /metadata\.verify/);
  assert.equal(result.review_chat_command, 'atris task review-chat OBL-TEST --as codex-review');
});

test('accepts third pass even with one actor', () => {
  const base = reviewTask();
  const result = evaluateAutoAccept({
    ...base,
    metadata: { ...base.metadata, agent_review_pass_count: 3 },
    review: { ...base.review, agent_review_pass_count: 3 },
    events: [{ event_type: 'proof_ready', actor: 'codex' }],
  });
  assert.equal(result.eligible, true);
  assert.equal(result.policy, '3_passes');
});

test('rejects denied tags and weak proof', () => {
  assert.equal(evaluateAutoAccept(reviewTask({ tag: 'voice' })).eligible, false);
  assert.equal(evaluateAutoAccept(reviewTask({
    metadata: { latest_agent_proof: 'done' },
    review: { proof: 'done' },
  })).eligible, false);
});

test('rejects proof that names an open draft PR boundary', () => {
  const proof = 'PR #1611 is still OPEN and draft=true, mergedAt=null. git diff --check passed.';
  const result = evaluateAutoAccept(reviewTask({
    metadata: { latest_agent_proof: proof },
    review: { proof },
  }));
  assert.equal(result.eligible, false);
  assert.equal(result.reason, 'proof_unmerged_or_draft_pr_boundary');
  assert.match(result.next_action, /revise/);
});

test('rejects proof that names a closed unmerged PR boundary', () => {
  const proof = 'PR #1585 is CLOSED with mergedAt=null after json.tool passed and git diff --check passed.';
  const result = evaluateAutoAccept(reviewTask({
    metadata: { latest_agent_proof: proof, agent_review_pass_count: 3 },
    review: { proof, agent_review_pass_count: 3 },
    events: [{ event_type: 'proof_ready', actor: 'codex' }],
  }));
  assert.equal(result.eligible, false);
  assert.equal(result.reason, 'proof_unmerged_or_draft_pr_boundary');
});

test('rejects stale proof that uses a bare PR number reference', () => {
  const proof = 'Verified #1600 remains OPEN/draft/CLEAN at head be8797f. git diff --check passed.';
  const result = evaluateAutoAccept(reviewTask({
    metadata: { latest_agent_proof: proof },
    review: { proof },
  }));
  assert.equal(result.eligible, false);
  assert.equal(result.reason, 'proof_unmerged_or_draft_pr_boundary');
});

test('reports PR boundary before generic weak proof', () => {
  const proof = 'Verified #1595 remains OPEN draft CLEAN for the canonical replacement.';
  const result = evaluateAutoAccept(reviewTask({
    metadata: { latest_agent_proof: proof },
    review: { proof },
  }));
  assert.equal(result.eligible, false);
  assert.equal(result.reason, 'proof_unmerged_or_draft_pr_boundary');
});

test('allows merged proof that explains the rejected PR boundary terms', () => {
  const proof = [
    'Merged PR #78 at origin/master commit 7944f271.',
    'Changed evaluator tests to reject proof text that names open draft, draft=true, isDraft=true, mergedAt=null, or closed-unmerged PR boundaries.',
    'git diff --check passed.',
  ].join(' ');
  const result = evaluateAutoAccept(reviewTask({
    metadata: { latest_agent_proof: proof, agent_review_pass_count: 3 },
    review: { proof, agent_review_pass_count: 3 },
    events: [{ event_type: 'proof_ready', actor: 'codex' }],
  }));
  assert.equal(result.eligible, true);
  assert.equal(result.policy, '3_passes');
});

test('rejects single actor with only two passes', () => {
  const result = evaluateAutoAccept(reviewTask({
    events: [{ event_type: 'proof_ready', actor: 'codex' }],
  }));
  assert.equal(result.eligible, false);
  assert.match(result.reason, /second_reviewer_or_third_pass/);
});

test('strict verify rejects compound shell commands', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-verify-'));
  const target = path.join(dir, 'pwned');
  const result = runVerifyCommand(`node --check lib/auto-accept-certified.js; echo pwned > ${target}`, process.cwd());
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'verify_command_not_allowed');
  assert.equal(fs.existsSync(target), false);
});

test('strict verify parser rejects path and npm config escapes', () => {
  assert.deepEqual(parseVerifyCommand('node --check lib/auto-accept-certified.js'), {
    ok: true,
    argv: ['node', '--check', 'lib/auto-accept-certified.js'],
  });
  assert.deepEqual(parseVerifyCommand('node --test --test-name-pattern=lineage test/commands.test.js'), {
    ok: true,
    argv: ['node', '--test', '--test-name-pattern=lineage', 'test/commands.test.js'],
  });
  assert.deepEqual(parseVerifyCommand('node bin/atris.js clean --dry-run --json'), {
    ok: true,
    argv: ['node', 'bin/atris.js', 'clean', '--dry-run', '--json'],
  });
  assert.equal(parseVerifyCommand('node bin/atris.js clean --json').ok, false);
  assert.equal(parseVerifyCommand('node bin/atris.js task accept CLI-1').ok, false);
  assert.equal(parseVerifyCommand('node scripts/../../tmp/pwn.js').ok, false);
  assert.equal(parseVerifyCommand('node --test ../../tmp/pwn.js').ok, false);
  assert.equal(parseVerifyCommand('npm run --script-shell=/bin/sh').ok, false);
  assert.equal(parseVerifyCommand('npm run test --prefix=/tmp/evil').ok, false);
  assert.equal(parseVerifyCommand('npm test --script-shell=scripts/malsh').ok, false);
  assert.equal(parseVerifyCommand('tsc --project=/tmp/evil/tsconfig.json').ok, false);
  assert.equal(parseVerifyCommand('git diff --check --output=/tmp/x').ok, false);
  assert.equal(parseVerifyCommand('node --test --test-reporter-destination=/tmp/x').ok, false);
  assert.equal(parseVerifyCommand('node --check --require=/tmp/pwn.js').ok, false);
  assert.equal(parseVerifyCommand('node --check file:///tmp/pwn.js').ok, false);
});

test('strict verify parser allows bounded git worktree diff checks', () => {
  const sibling = path.join(os.tmpdir(), 'sibling-worktree');
  const parsed = parseVerifyCommand(`git -C ${sibling} diff --check origin/master^ origin/master`);
  assert.deepEqual(parsed, {
    ok: true,
    argv: ['git', '-C', sibling, 'diff', '--check', 'origin/master^', 'origin/master'],
  });
  assert.deepEqual(parseVerifyCommand('git diff --check HEAD~1 HEAD'), {
    ok: true,
    argv: ['git', 'diff', '--check', 'HEAD~1', 'HEAD'],
  });
  assert.equal(parseVerifyCommand('git -C ../../outside diff --check').ok, false);
  assert.equal(parseVerifyCommand('git -C /tmp/evil diff --check --output=/tmp/x').ok, false);
});

test('strict verify runtime blocks git -C outside the workspace parent', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-verify-parent-'));
  const workspace = path.join(parent, 'workspace');
  const sibling = path.join(parent, 'sibling');
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-verify-outside-'));
  fs.mkdirSync(workspace);
  fs.mkdirSync(sibling);

  const allowed = runVerifyCommand(`git -C ${sibling} diff --check`, workspace);
  assert.notEqual(allowed.reason, 'verify_command_not_allowed');

  const denied = runVerifyCommand(`git -C ${outside} diff --check`, workspace);
  assert.equal(denied.ok, false);
  assert.equal(denied.reason, 'verify_command_not_allowed');
});
