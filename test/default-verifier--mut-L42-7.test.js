const test = require('node:test');
const assert = require('node:assert/strict');
const { verifierBudgetWarning } = require('../lib/default-verifier');

test('npm test warns that the broad suite may exceed the verifier window', () => {
  const warning = verifierBudgetWarning('npm test', {
    ATRIS_MISSION_VERIFIER_TIMEOUT_MS: '90000',
  });
  assert.equal(warning?.code, 'verifier_may_outlive_window');
});
