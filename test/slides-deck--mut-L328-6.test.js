const test = require('node:test');
const assert = require('node:assert/strict');
const { buildDeck } = require('../lib/slides-deck');

test('a closing slide displays the name from its brand settings', () => {
  const { requests } = buildDeck({
    brand: { name: 'Northstar' },
    slides: [{ type: 'close', tagline: 'See you soon' }],
  });
  const brandText = requests.find((request) => request.insertText).insertText.text;
  assert.strictEqual(brandText, 'Northstar');
});
