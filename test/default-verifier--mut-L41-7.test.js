const test = require('node:test');
const assert = require('node:assert/strict');

const { verifierBudgetWarning } = require('../lib/default-verifier');

test('broad suite warning fires when running tests directory', () => {
  const warning = verifierBudgetWarning('node --test tests');
  assert.equal(warning?.code, 'verifier_may_outlive_window');
});
