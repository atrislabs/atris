const test = require('node:test');
const assert = require('node:assert');
const { safeLineMerge } = require('../commands/business-sync');

test('non overlapping line insertions merge cleanly', () => {
  const base = 'a\nb\nc';
  const local = 'x\na\nb\nc';
  const remote = 'a\nb\nc\ny';

  const result = safeLineMerge(base, local, remote);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.content, 'x\na\nb\nc\ny');
});
