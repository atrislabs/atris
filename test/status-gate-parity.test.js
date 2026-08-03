// This test is the "no lying surfaces" invariant.
// If you add an eligibility rule to the landing path, add it to the static
// status path too or this test breaks.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { evaluateAutoAccept } = require('../lib/auto-accept-certified');
const { isDecisionTask } = require('../lib/task-decision');

const RUNTIME_ONLY_REFUSALS = new Set([
  'verify_failed',
  'verify_unrunnable',
  'verify_worktree_missing',
]);

function verdict(evaluation) {
  return JSON.stringify({
    eligible: evaluation.eligible,
    reason: evaluation.reason,
  });
}

test('status never promises a landing the gate will statically refuse', (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-status-gate-parity-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));

  const stateDir = path.join(workspace, '.atris', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const trustedHistory = Array.from({ length: 10 }, () => JSON.stringify({
    claimed_by: 'trusted-builder',
    outcome: 'accepted',
  }));
  fs.writeFileSync(
    path.join(stateDir, 'career_xp_receipts.jsonl'),
    `${trustedHistory.join('\n')}\n`,
  );
  fs.writeFileSync(path.join(stateDir, 'scorecards.jsonl'), '');
  fs.writeFileSync(
    path.join(workspace, 'passing.js'),
    "module.exports = true;\n",
  );
  fs.writeFileSync(
    path.join(workspace, 'failing.js'),
    "module.exports = ;\n",
  );

  const passingVerify = 'node --check passing.js';
  const executedProof = `[verified] \`${passingVerify}\` passed (exit 0)`;
  const baseTask = {
    status: 'review',
    tag: 'code',
    claimed_by: 'trusted-builder',
    workspace_root: workspace,
    metadata: {
      agent_certified: true,
      agent_review_pass_count: 2,
      verify: passingVerify,
    },
    review: {
      approval_status: 'pending',
      proof: executedProof,
    },
    events: [
      { event_type: 'proof_ready', actor: 'trusted-builder' },
      { event_type: 'reviewed', actor: 'independent-reviewer' },
    ],
  };

  const fixtures = [
    {
      name: 'denied security tag',
      task: { ...baseTask, id: 'denied-tag', tag: 'security' },
      expectedReason: 'denied_tag_security',
    },
    {
      name: 'declared protected lane',
      task: { ...baseTask, id: 'protected-lane', title: 'human review required before landing' },
      expectedReason: 'declared_protected_lane',
    },
    {
      name: 'missing verify command',
      task: {
        ...baseTask,
        id: 'missing-verify',
        metadata: { ...baseTask.metadata, verify: '' },
      },
      expectedReason: 'strict_verify_missing',
    },
    {
      name: 'disallowed verify command',
      task: {
        ...baseTask,
        id: 'disallowed-verify',
        metadata: { ...baseTask.metadata, verify: 'bash scripts/check.sh' },
      },
      expectedReason: 'verify_command_not_allowed',
    },
    {
      name: 'probation without independent review',
      task: {
        ...baseTask,
        id: 'probation-no-review',
        claimed_by: 'probation-builder',
        events: [{ event_type: 'proof_ready', actor: 'probation-builder' }],
      },
      expectedReason: 'probation_needs_review',
    },
    {
      name: 'certified with allowed verify',
      task: { ...baseTask, id: 'certified-allowed' },
      expectedEligible: true,
    },
    {
      name: 'suite-green proof without CI citation',
      task: {
        ...baseTask,
        id: 'uncited-suite-green',
        review: { ...baseTask.review, proof: 'suite green' },
      },
      expectedReason: 'cite the CI run URL, run id, or commit-pinned verify command with exit 0 before claiming the suite is green',
    },
    {
      name: 'decision-tagged review',
      task: {
        ...baseTask,
        id: 'decision-tagged',
        metadata: { ...baseTask.metadata, tags: ['decision'] },
      },
      decision: true,
    },
    {
      name: 'runtime verify failure',
      task: {
        ...baseTask,
        id: 'runtime-failure',
        metadata: { ...baseTask.metadata, verify: 'node --check failing.js' },
      },
      expectedStatusEligible: true,
      expectedLandingReason: 'verify_failed',
    },
  ];

  for (const fixture of fixtures) {
    const statusVerdict = evaluateAutoAccept(fixture.task, {
      strictVerify: true,
      acceptAll: false,
      executeVerify: false,
    });
    const landingVerdict = evaluateAutoAccept(fixture.task, {
      strictVerify: true,
      acceptAll: false,
      executeVerify: true,
    });
    const comparison = `${fixture.name}: status=${verdict(statusVerdict)} landing=${verdict(landingVerdict)}`;

    if (fixture.expectedReason) {
      assert.equal(statusVerdict.reason, fixture.expectedReason, comparison);
      assert.equal(landingVerdict.reason, fixture.expectedReason, comparison);
    }
    if (fixture.expectedEligible) {
      assert.equal(statusVerdict.eligible, true, comparison);
      assert.equal(landingVerdict.eligible, true, comparison);
    }
    if (fixture.expectedStatusEligible) {
      assert.equal(statusVerdict.eligible, true, comparison);
    }
    if (fixture.expectedLandingReason) {
      assert.equal(landingVerdict.reason, fixture.expectedLandingReason, comparison);
    }
    if (fixture.decision) {
      assert.equal(isDecisionTask(fixture.task), true, `${fixture.name}: fixture must remain decision-tagged`);
    }

    if (statusVerdict.eligible && !landingVerdict.eligible) {
      assert.ok(RUNTIME_ONLY_REFUSALS.has(landingVerdict.reason), comparison);
    }
  }
});
