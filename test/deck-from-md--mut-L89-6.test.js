const test = require('node:test');
const assert = require('node:assert/strict');
const { parseMarkdownToSpec } = require('../lib/deck-from-md');

test('a document starting with H2 keeps its opening section as a statement', () => {
  const spec = parseMarkdownToSpec('## Project progress\n\nThe rollout is underway.\n');

  assert.strictEqual(spec.slides[0].type, 'statement');
});
