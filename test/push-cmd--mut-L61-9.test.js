const test = require('node:test');
const assert = require('node:assert/strict');
const { parsePushArgv } = require('../commands/push');

test('an empty quoted business argument does not become a file scope', () => {
  const parsed = parsePushArgv(['node', 'atris', 'push', '', 'example-co']);
  assert.strictEqual(parsed.pathArgs.includes(''), false);
});
