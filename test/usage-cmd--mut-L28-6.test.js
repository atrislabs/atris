'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { renderUsage } = require('../commands/usage');

test('flat usage excludes agent identity from metric rows', () => {
  const output = renderUsage({
    agent_name: 'studio assistant',
    agent_id: 'agent-studio',
    requests: 12,
  });

  assert.equal(/^agent_(?:name|id):/m.test(output), false);
});
