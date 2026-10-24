const test = require('node:test');
const assert = require('node:assert/strict');
const { buildRemoteAtrisBootstrapCommand } = require('../lib/runtime-bootstrap');

test('remote receipt retains a supplied business id without other identity fields', () => {
  const command = buildRemoteAtrisBootstrapCommand({ businessId: 'biz-customer-project' });
  const assignment = command.split('\n').find(line => line.startsWith('BUSINESS_ID='));

  assert.strictEqual(assignment?.slice('BUSINESS_ID='.length), "'biz-customer-project'");
});
