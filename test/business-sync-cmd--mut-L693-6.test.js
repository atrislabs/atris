const test = require('node:test');
const assert = require('node:assert/strict');
const { safeLineMerge } = require('../commands/business-sync');

test('merge refuses identical replacements covering different overlapping spans', () => {
  // Local replaces two lines; cloud replaces just the first with the same text.
  // Their starts match, but accepting either edit would discard the other intent.
  const result = safeLineMerge(
    'old heading\nkeep this note\nfooter\n',
    'new heading\nfooter\n',
    'new heading\nkeep this note\nfooter\n'
  );

  assert.strictEqual(result.ok, false);
});
