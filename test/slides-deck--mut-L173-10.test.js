const test = require('node:test');
const assert = require('node:assert/strict');
const { buildDeck } = require('../lib/slides-deck');

test('panel subtitle styling starts after the title and newline', () => {
  const { requests } = buildDeck({
    slides: [{ type: 'panel', panel: { rows: [{ title: 'Service', sub: 'Healthy' }] } }],
  });
  const text = requests.find((r) => r.insertText && r.insertText.text.includes('Healthy')).insertText;
  const subtitleStyle = requests.find((r) => r.updateTextStyle
    && r.updateTextStyle.objectId === text.objectId
    && r.updateTextStyle.style.fontSize?.magnitude === 9
    && r.updateTextStyle.textRange.type === 'FIXED_RANGE').updateTextStyle;
  assert.strictEqual(subtitleStyle.textRange.startIndex, text.text.indexOf('Healthy'));
});
