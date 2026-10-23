const test = require('node:test');
const assert = require('node:assert/strict');
const { plainText } = require('../lib/task-explanation');

test('expands tool and connection abbreviations with their distinct meanings', () => {
  assert.strictEqual(plainText('CLI'), 'command tool');
  assert.strictEqual(plainText('API'), 'connection');
});
