const test = require('node:test');
const assert = require('node:assert/strict');
const goal = require('../lib/ax-goal');

test('parseGoalCommand handles set, status, clear, and token budget', () => {
  assert.deepEqual(goal.parseGoalCommand('/goal'), { action: 'status' });
  assert.deepEqual(goal.parseGoalCommand('/goal clear'), { action: 'clear' });
  assert.deepEqual(goal.parseGoalCommand('/goal stop'), { action: 'clear' });
  assert.deepEqual(goal.parseGoalCommand('/goal npm test exits 0, max 5 turns'), {
    action: 'set',
    condition: 'npm test exits 0, max 5 turns',
    maxTurns: 5,
    tokenBudget: null,
  });
  assert.deepEqual(goal.parseGoalCommand('/goal --tokens 250K fix the failing suite'), {
    action: 'set',
    condition: 'fix the failing suite',
    maxTurns: null,
    tokenBudget: 250000,
  });
});

test('goal evaluator parses json and achieved markers', () => {
  assert.deepEqual(
    goal.parseGoalEvalResponse('{"achieved": true, "reason": "tests passed"}'),
    { achieved: true, reason: 'tests passed' }
  );
  assert.deepEqual(
    goal.parseGoalAchievedMarker('done\nGOAL_ACHIEVED: npm test passed'),
    { achieved: true, reason: 'npm test passed' }
  );
});

test('goal counter and achieved formatting', () => {
  const active = goal.createGoalState('npm test exits 0', { maxTurns: 3 });
  active.turns = 2;
  active.startedAt = Date.now() - 5000;
  active.lastReason = 'tests still failing';

  assert.match(goal.formatGoalStatus(active, { paint: (t) => t, bold: '', magenta: '', muted: '' }), /◎ \/goal active/);
  assert.match(goal.formatGoalStatus(active, { paint: (t) => t, bold: '', magenta: '', muted: '' }), /turn 2\/3/);
  assert.match(goal.formatGoalActiveBanner(active, { paint: (t) => t, bold: '', magenta: '' }), /npm test exits 0/);

  goal.finishGoalAchieved(active, 'npm test passed');
  assert.match(goal.formatGoalAchieved(active, { paint: (t) => t, bold: '', magenta: '', muted: '', accent: '' }), /Goal achieved/);
  assert.match(goal.formatGoalAchieved(active, { paint: (t) => t, bold: '', magenta: '', muted: '', accent: '' }), /2\/3 turns/);
});

test('evaluateGoalTurn uses injected evaluator and marker fallback', async () => {
  const state = goal.createGoalState('ship fix');
  const injected = await goal.evaluateGoalTurn(state, {
    history: [{ role: 'assistant', content: 'fixed it' }],
    lastOutput: 'all good',
  }, {
    evaluateGoal: async () => ({ achieved: true, reason: 'verified in tests' }),
  });
  assert.equal(injected.achieved, true);

  const marker = await goal.evaluateGoalTurn(state, {
    history: [],
    lastOutput: 'GOAL_ACHIEVED: suite green',
  }, {});
  assert.equal(marker.achieved, true);
});
