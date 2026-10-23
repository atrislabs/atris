const test = require('node:test');
const assert = require('node:assert/strict');
const { buildDeck } = require('../lib/slides-deck');

test('receipt field value has the exact width reserved inside its panel', () => {
  const { requests } = buildDeck({
    slides: [{ type: 'receipt', fields: [{ k: 'Status', v: 'Delivered' }] }],
  });
  const text = requests.find((request) => request.insertText?.text === 'Delivered');
  assert.ok(text, 'receipt field value must be rendered');
  const shape = requests.find((request) =>
    request.createShape?.objectId === text.insertText.objectId);
  assert.ok(shape, 'receipt field value must have a text box');
  assert.deepEqual(shape.createShape.elementProperties.size.width, {
    magnitude: 180,
    unit: 'PT',
  });
});
