const test = require('node:test');
const assert = require('node:assert/strict');
const { verifierBudgetWarning } = require('../lib/default-verifier');

test('an explicit test directory receives a broad suite budget warning', () => {
  const warning = verifierBudgetWarning('node --test test', {
    ATRIS_MISSION_VERIFIER_TIMEOUT_MS: '90000',
  });
  assert.equal(warning?.code, 'verifier_may_outlive_window');
});
