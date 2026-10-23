const test = require('node:test');
const assert = require('node:assert/strict');
const { buildDeck } = require('../lib/slides-deck');

test('bullets archetype positions bullet accent dot at M + 1', () => {
  const spec = {
    slides: [
      {
        type: 'bullets',
        items: ['First point'],
      },
    ],
  };
  const { requests } = buildDeck(spec);
  const ellipse = requests.find((r) => r.createShape && r.createShape.shapeType === 'ELLIPSE');
  assert.ok(ellipse, 'expected bullet accent dot ellipse');
  assert.equal(ellipse.createShape.elementProperties.transform.translateX, 49);
});
