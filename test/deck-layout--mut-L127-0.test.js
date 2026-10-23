const test = require('node:test');
const assert = require('node:assert/strict');
const { planLayout } = require('../lib/deck-layout');

test('stack items preserve string layer titles', () => {
  const [slide] = planLayout([
    { kind: 'stack', items: ['Draft'] },
  ], { style: 'dense' });

  assert.strictEqual(slide.layers[0].title, 'Draft');
});
