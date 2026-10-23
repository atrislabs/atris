const test = require('node:test');
const assert = require('node:assert/strict');
const { planLayout } = require('../lib/deck-layout');

test('chip sections preserve the supplied chip text', () => {
  const [slide] = planLayout([
    { kind: 'chips', heading: 'Supported formats', chips: ['PDF', 'HTML'] },
  ], { style: 'dense' });

  assert.strictEqual(slide.chips[0], 'PDF');
});
