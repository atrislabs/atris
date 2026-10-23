const test = require('node:test');
const assert = require('node:assert/strict');
const { composeSpec } = require('../lib/deck-compose');

test('composeSpec uses the level-one title when a lower-level heading comes first', () => {
  const spec = composeSpec(
    '## Opening section\n\nOpening support.\n\n# Actual document title\n\nMain support.'
  );

  assert.deepEqual(spec, {
    theme: 'ink',
    brand: { name: 'Actual document title', accent: '.' },
    slides: [
      { type: 'lede', headline: 'Actual document title', dek: 'Opening support.' },
      { type: 'statement', text: 'Actual document title', sub: 'Main support.' },
      { type: 'hero', headline: 'Actual document title' },
    ],
  });
});
