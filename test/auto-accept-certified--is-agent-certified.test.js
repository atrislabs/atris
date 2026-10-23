'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { isAgentCertified, AGENT_CERTIFICATION_REVIEW_PASSES } = require('../lib/auto-accept-certified');

test('certification bar is two review passes', () => {
  assert.strictEqual(AGENT_CERTIFICATION_REVIEW_PASSES, 2);
});

test('an empty task is not certified', () => {
  assert.strictEqual(isAgentCertified({}), false);
  assert.strictEqual(isAgentCertified({ metadata: null, review: null }), false);
  assert.strictEqual(isAgentCertified({ metadata: {}, review: {} }), false);
});

test('metadata.agent_certified true certifies', () => {
  assert.strictEqual(isAgentCertified({ metadata: { agent_certified: true } }), true);
});

test('review.agent_certified true certifies', () => {
  assert.strictEqual(isAgentCertified({ review: { agent_certified: true } }), true);
});

test('agent_certified must be the boolean true, not a truthy lookalike', () => {
  assert.strictEqual(isAgentCertified({ metadata: { agent_certified: 'true' } }), false);
  assert.strictEqual(isAgentCertified({ metadata: { agent_certified: 1 } }), false);
  assert.strictEqual(isAgentCertified({ review: { agent_certified: 'yes' } }), false);
  assert.strictEqual(isAgentCertified({ metadata: { agent_certified: false } }), false);
});

test('either flag is enough when the other says no', () => {
  assert.strictEqual(
    isAgentCertified({ metadata: { agent_certified: false }, review: { agent_certified: true } }),
    true,
  );
  assert.strictEqual(
    isAgentCertified({ metadata: { agent_certified: true }, review: { agent_certified: false } }),
    true,
  );
});

test('handoff.native_goal_status agent_certified certifies', () => {
  const task = { review: { handoff: { native_goal_status: 'agent_certified' } } };
  assert.strictEqual(isAgentCertified(task), true);
});

test('other handoff statuses and malformed handoffs do not certify', () => {
  assert.strictEqual(isAgentCertified({ review: { handoff: { native_goal_status: 'in_progress' } } }), false);
  assert.strictEqual(isAgentCertified({ review: { handoff: { native_goal_status: 'AGENT_CERTIFIED' } } }), false);
  assert.strictEqual(isAgentCertified({ review: { handoff: {} } }), false);
  assert.strictEqual(isAgentCertified({ review: { handoff: null } }), false);
  assert.strictEqual(isAgentCertified({ review: { handoff: 'agent_certified' } }), false);
  assert.strictEqual(isAgentCertified({ review: { handoff: ['agent_certified'] } }), false);
});

test('two review passes certify, one does not', () => {
  assert.strictEqual(isAgentCertified({ metadata: { agent_review_pass_count: 1 } }), false);
  assert.strictEqual(isAgentCertified({ metadata: { agent_review_pass_count: 2 } }), true);
  assert.strictEqual(isAgentCertified({ metadata: { agent_review_pass_count: 7 } }), true);
  assert.strictEqual(isAgentCertified({ metadata: { agent_review_pass_count: 0 } }), false);
});

test('review pass count falls back to the review block', () => {
  assert.strictEqual(isAgentCertified({ review: { agent_review_pass_count: 2 } }), true);
  assert.strictEqual(isAgentCertified({ review: { agent_review_pass_count: 1 } }), false);
  assert.strictEqual(isAgentCertified({ metadata: { agent_review_pass_count: null }, review: { agent_review_pass_count: 3 } }), true);
});

test('metadata pass count wins over the review block, even when it is zero', () => {
  const task = { metadata: { agent_review_pass_count: 0 }, review: { agent_review_pass_count: 5 } };
  assert.strictEqual(isAgentCertified(task), false);
  const high = { metadata: { agent_review_pass_count: 4 }, review: { agent_review_pass_count: 0 } };
  assert.strictEqual(isAgentCertified(high), true);
});

test('pass counts are coerced as numbers and junk counts as zero', () => {
  assert.strictEqual(isAgentCertified({ metadata: { agent_review_pass_count: '2' } }), true);
  assert.strictEqual(isAgentCertified({ metadata: { agent_review_pass_count: '1' } }), false);
  assert.strictEqual(isAgentCertified({ metadata: { agent_review_pass_count: 'many' } }), false);
  assert.strictEqual(isAgentCertified({ metadata: { agent_review_pass_count: NaN } }), false);
  assert.strictEqual(isAgentCertified({ metadata: { agent_review_pass_count: Infinity } }), false);
  assert.strictEqual(isAgentCertified({ metadata: { agent_review_pass_count: -3 } }), false);
});

test('a task with no certification signals but unrelated fields stays uncertified', () => {
  const task = {
    id: 'task-1',
    status: 'review',
    metadata: { verify: 'npm test', latest_agent_proof: 'ran the suite' },
    review: { approval_status: 'pending', proof: 'looks good' },
  };
  assert.strictEqual(isAgentCertified(task), false);
});

test('a missing task throws instead of quietly returning false', () => {
  assert.throws(() => isAgentCertified(undefined), TypeError);
  assert.throws(() => isAgentCertified(null), TypeError);
});
