const test = require('node:test');
const assert = require('node:assert/strict');
const { planLayout } = require('../lib/deck-layout');

test('cover uses the supplied heading when no headline is present', () => {
  const [slide] = planLayout([{ kind: 'cover', heading: 'A clearer direction' }]);

  assert.strictEqual(slide.headline, 'A clearer direction');
});
