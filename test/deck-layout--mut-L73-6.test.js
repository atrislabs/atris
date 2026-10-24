const test = require('node:test');
const assert = require('node:assert/strict');
const { planLayout } = require('../lib/deck-layout');

test('incomplete side does not convert to items', () => {
  const [slide] = planLayout([
    { kind: 'bullets', heading: 'Overview', left: { label: 'Old', items: ['a'] } },
  ]);
  assert.equal(slide.type, 'statement');
});
