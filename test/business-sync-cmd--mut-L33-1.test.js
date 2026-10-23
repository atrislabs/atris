const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseBusinessSyncArgs } = require('../commands/business-sync');

test('positional resolve uses the following word as the resolution choice', () => {
  const options = parseBusinessSyncArgs(['resolve', 'cloud']);

  assert.equal(options.resolve, 'cloud');
});
