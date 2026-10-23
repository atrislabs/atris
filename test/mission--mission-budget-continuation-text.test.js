'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { missionBudgetContinuationText } = require('../commands/mission');

const startedAt = '2025-01-15T12:00:00.000Z';
const nowMs = Date.parse('2025-01-15T12:30:00.000Z');

function mission(overrides = {}) {
  return {
    status: 'running',
    started_at: startedAt,
    budget_contract: {
      policy: 'spend_full_budget',
      requested_seconds: 3600,
      budget_label: '1 hour',
    },
    ...overrides,
  };
}

test('describes the remaining full-budget commitment for active missions', () => {
  for (const status of ['planning', 'running', 'ready']) {
    assert.strictEqual(
      missionBudgetContinuationText(mission({ status }), nowMs),
      'keep shipping bounded improvements for the remaining 30m of the 1-hour commitment',
    );
  }
  assert.strictEqual(
    missionBudgetContinuationText(mission({
      budget_contract: {
        policy: 'spend_full_budget',
        requested_seconds: 3600,
        budget_label: ' 60 MINUTES ',
      },
    }), nowMs),
    'keep shipping bounded improvements for the remaining 30m of the 60-minute commitment',
  );
});

test('a later resume restarts the budget and fractional seconds round up', () => {
  const resumed = mission({ resumed_at: '2025-01-16T12:00:00.000Z' });
  assert.strictEqual(
    missionBudgetContinuationText(resumed, Date.parse('2025-01-16T12:59:59.500Z')),
    'keep shipping bounded improvements for the remaining 1s of the 1-hour commitment',
  );
  assert.strictEqual(
    missionBudgetContinuationText(resumed, Date.parse('2025-01-16T13:00:00.000Z')),
    null,
  );
});

test('returns no continuation for inactive, empty, invalid, or expired missions', () => {
  for (const status of ['paused', 'stopped', 'blocked', 'complete', 'unknown', '']) {
    assert.strictEqual(missionBudgetContinuationText(mission({ status }), nowMs), null);
  }
  for (const input of [undefined, null, {}, mission({ budget_contract: null }),
    mission({ started_at: 'invalid' }),
    mission({ budget_contract: { policy: 'finish_on_pass', requested_seconds: 3600 } }),
    mission({ budget_contract: { policy: 'spend_full_budget', requested_seconds: -1 } })]) {
    assert.strictEqual(missionBudgetContinuationText(input, nowMs), null);
  }
  assert.strictEqual(
    missionBudgetContinuationText(mission(), Date.parse('2025-01-15T13:00:00.000Z')),
    null,
  );
});
