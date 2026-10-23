const test = require('node:test');
const assert = require('node:assert/strict');
const { planLayout } = require('../lib/deck-layout');

test('narrative comparison preserves the left column label', () => {
  const [slide] = planLayout([{
    kind: 'compare',
    left: { label: 'Manual review', items: ['Read each submission'] },
    right: { label: 'Automatic review', items: ['Check submissions together'] },
  }], { style: 'narrative' });

  assert.strictEqual(slide.columns[0].h, 'Manual review');
});
