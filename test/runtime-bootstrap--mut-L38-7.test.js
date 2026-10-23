const test = require('node:test');
const assert = require('node:assert/strict');
const { buildRemoteAtrisBootstrapCommand } = require('../lib/runtime-bootstrap');

test('remote bootstrap preserves the workspace identity for its receipt', () => {
  const command = buildRemoteAtrisBootstrapCommand({ workspaceId: 'ws-customer-project' });
  const assignment = command.split('\n').find(line => line.startsWith('WORKSPACE_ID='));

  assert.strictEqual(assignment, "WORKSPACE_ID='ws-customer-project'");
});
