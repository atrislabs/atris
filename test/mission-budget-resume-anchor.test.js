const test = require('node:test');
const assert = require('node:assert/strict');

const { missionFullBudgetRemainingSeconds } = require('../commands/mission');

// Footgun (d): the spend-full-budget commitment clock anchored to started_at,
// so a mission resumed after its original window elapsed landed on the first
// tick. The clock now anchors to the most recent run start (resumed_at).

const THREE_HOURS = 3 * 60 * 60;

function fullBudgetMission(overrides = {}) {
  return {
    budget_contract: { policy: 'spend_full_budget', requested_seconds: THREE_HOURS },
    ...overrides,
  };
}

test('never-paused mission still measures from started_at (unchanged)', () => {
  const now = Date.parse('2026-07-16T12:00:00Z');
  const mission = fullBudgetMission({ started_at: '2026-07-16T11:00:00Z' });
  const remaining = missionFullBudgetRemainingSeconds(mission, now);
  assert.equal(remaining, 2 * 60 * 60); // 3h budget, 1h elapsed -> 2h left
});

test('mission whose original window elapsed reads zero without a resume', () => {
  const now = Date.parse('2026-07-16T20:00:00Z');
  const mission = fullBudgetMission({ started_at: '2026-07-16T11:00:00Z' }); // 9h ago
  assert.equal(missionFullBudgetRemainingSeconds(mission, now), 0);
});

test('resume re-opens the full window from resumed_at', () => {
  const now = Date.parse('2026-07-16T20:00:00Z');
  const mission = fullBudgetMission({
    started_at: '2026-07-16T11:00:00Z', // original window long gone
    resumed_at: '2026-07-16T19:30:00Z', // resumed 30m ago
  });
  const remaining = missionFullBudgetRemainingSeconds(mission, now);
  assert.equal(remaining, THREE_HOURS - 30 * 60); // 2h30m left, not 0
});

test('anchors to the later of started_at and resumed_at (stale resumed_at ignored)', () => {
  const now = Date.parse('2026-07-16T12:00:00Z');
  const mission = fullBudgetMission({
    started_at: '2026-07-16T11:30:00Z', // more recent
    resumed_at: '2026-07-16T09:00:00Z', // stale
  });
  const remaining = missionFullBudgetRemainingSeconds(mission, now);
  assert.equal(remaining, THREE_HOURS - 30 * 60); // measured from 11:30, not 09:00
});

test('non-full-budget mission is unaffected', () => {
  const mission = { started_at: '2026-07-16T11:00:00Z', resumed_at: '2026-07-16T19:30:00Z' };
  assert.equal(missionFullBudgetRemainingSeconds(mission, Date.parse('2026-07-16T20:00:00Z')), 0);
});
