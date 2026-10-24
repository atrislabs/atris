const test = require('node:test');
const assert = require('node:assert/strict');
const { buildDeck } = require('../lib/slides-deck');

test('panel row title is rendered into slide text', () => {
  const spec = {
    slides: [
      {
        type: 'panel',
        panel: {
          rows: [{ title: 'Service Status' }],
        },
      },
    ],
  };
  const { requests } = buildDeck(spec);
  const found = requests.some((r) => r.insertText && r.insertText.text === 'Service Status');
  assert.equal(found, true);
});
