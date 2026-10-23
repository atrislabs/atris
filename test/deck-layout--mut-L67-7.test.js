const test = require('node:test');
const assert = require('node:assert/strict');
const { planLayout } = require('../lib/deck-layout');

test('layer objects become bullet items whose text is the layer title', () => {
  const [slide] = planLayout([
    {
      kind: 'points',
      heading: 'Layered',
      layers: [
        { title: 'Alpha', sub: 'detail one' },
        { title: 'Beta', h: 'heading fallback', sub: 'detail two' },
      ],
    },
  ], { style: 'dense' });
  assert.equal(slide.items[0].text, 'Alpha');
  assert.equal(slide.items[1].text, 'Beta');
});
