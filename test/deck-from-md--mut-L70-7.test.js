const test = require('node:test');
const assert = require('node:assert/strict');
const { parseMarkdownToSpec } = require('../lib/deck-from-md');

test('uses the front matter accent when no accent option is supplied', () => {
  const spec = parseMarkdownToSpec('---\naccent: !\n---\n# Hello\n');

  assert.equal(spec.brand.accent, '!');
});
