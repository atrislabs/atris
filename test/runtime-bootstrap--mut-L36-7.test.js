const test = require('node:test');
const assert = require('node:assert/strict');
const { buildRemoteAtrisBootstrapCommand } = require('../lib/runtime-bootstrap');

test('computer creation preserves its boundary in the generated receipt command', () => {
  const command = buildRemoteAtrisBootstrapCommand({
    boundary: 'computer-create',
    businessSlug: 'example-co',
    businessId: 'biz-1',
    workspaceId: 'ws-1',
  });

  const assignment = command.split('\n').find(line => line.startsWith('BOUNDARY='));
  assert.strictEqual(assignment.slice('BOUNDARY='.length), "'computer-create'");
});
