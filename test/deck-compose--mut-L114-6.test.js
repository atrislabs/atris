const test = require('node:test');
const assert = require('node:assert/strict');
const { composeSpec } = require('../lib/deck-compose');

test('composeSpec uses the opening statement support as the cover subtitle', () => {
  const spec = composeSpec('# A clear title\n\nSupporting detail.');

  assert.deepEqual(spec.slides[0], {
    type: 'lede',
    headline: 'A clear title',
    dek: 'Supporting detail.',
  });
});
