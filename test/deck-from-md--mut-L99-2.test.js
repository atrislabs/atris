const test = require('node:test');
const assert = require('node:assert/strict');
const { parseMarkdownToSpec } = require('../lib/deck-from-md');

test('a section with exactly two short bullets becomes a columns slide', () => {
  const spec = parseMarkdownToSpec([
    '# Product overview',
    '',
    '## Benefits',
    '',
    '- Fast: ship changes quickly',
    '- Clear: understand every update',
  ].join('\n'));

  assert.strictEqual(spec.slides[1].type, 'columns');
});
