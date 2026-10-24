const test = require('node:test');
const assert = require('node:assert/strict');
const { runBudgetSeconds } = require('../commands/run-front');

test('a numeric objective without budget flags does not set a run budget', () => {
  assert.equal(runBudgetSeconds(['2']), null);
});
