const test = require('node:test');
const assert = require('node:assert/strict');

const { buildRemoteAtrisBootstrapCommand } = require('../lib/runtime-bootstrap');

test('remote receipt command preserves the supplied business slug', () => {
  const command = buildRemoteAtrisBootstrapCommand({ businessSlug: 'example-co' });
  const assignment = command.match(/^BUSINESS_SLUG='([^']*)'$/m);

  assert.strictEqual(assignment && assignment[1], 'example-co');
});
