const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSpawnArgs } = require('../commands/agent-spawn');

test('omitting the engine flag keeps the manual engine default', () => {
  const options = parseSpawnArgs(['codex', '--task', 'Review the changes']);
  assert.strictEqual(options.engine, 'manual');
});
