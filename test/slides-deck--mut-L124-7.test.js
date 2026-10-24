const test = require('node:test');
const assert = require('node:assert/strict');
const { buildDeck } = require('../lib/slides-deck');

test('an empty emphasis span emits no style request (zero-length ranges are skipped)', () => {
  const spec = { theme: 'paper', brand: { name: 'X' }, slides: [{ type: 'statement', text: 'a****b' }] };
  const { requests } = buildDeck(spec);
  const zeroLen = requests.filter(
    (r) => r.updateTextStyle
      && r.updateTextStyle.textRange
      && r.updateTextStyle.textRange.startIndex === r.updateTextStyle.textRange.endIndex,
  );
  assert.equal(zeroLen.length, 0, 'a style request went out for a zero-length text range');
});
