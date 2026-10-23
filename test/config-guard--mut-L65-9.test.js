'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { commandMentionsClaudeSettings, enforceConfigGuard } = require('../lib/config-guard');

test('a whitespace-only Bash command does not mention Claude settings and is allowed', () => {
  const command = ' \t\n\r ';

  assert.equal(commandMentionsClaudeSettings(command), false);
  assert.deepEqual(enforceConfigGuard({
    tool_name: 'Bash',
    tool_input: { command },
  }), { allowed: true });
});
