const test = require('node:test');
const assert = require('node:assert/strict');
const { buildDeck } = require('../lib/slides-deck');

test('quote text box preserves the slide content width with equal side margins', () => {
  const text = 'Keep the reader in view.';
  const { requests } = buildDeck({ slides: [{ type: 'quote', text }] });
  const quote = requests.find((request) => request.insertText?.text === text).insertText;
  const shape = requests.find((request) => request.createShape?.objectId === quote.objectId).createShape;

  assert.strictEqual(shape.elementProperties.size.width.magnitude, 592);
});
