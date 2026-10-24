const test = require('node:test');
const assert = require('node:assert/strict');
const { planLayout } = require('../lib/deck-layout');

test('columns retain headings from string items and text items', () => {
  const [slide] = planLayout([
    { kind: 'columns', items: ['Launch', { text: 'Ship', sub: 'Today' }] },
  ]);
  assert.strictEqual(slide.columns[0].h, 'Launch');
  assert.strictEqual(slide.columns[1].h, 'Ship');
});
