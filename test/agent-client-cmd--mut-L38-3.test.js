'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseAgentClientArgs } = require('../commands/agent-client');

test('create rejects a zero token lifetime', () => {
  const result = parseAgentClientArgs([
    'create', '--name', 'bot', '--scopes', 'mcp:read', '--ttl', '0',
  ]);

  assert.match(result.error || '', /positive/);
});
