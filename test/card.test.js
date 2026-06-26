const test = require('node:test');
const assert = require('node:assert/strict');
const { buildCard, SIZES, KINDS } = require('../lib/card');
const { THEMES: HTML_THEMES } = require('../lib/html-render');
const { normalizeTheme } = require('../lib/theme');

test('statement card embeds the headline and the theme tokens', () => {
  const card = buildCard({ kind: 'statement', headline: 'Ship faster' });
  assert.equal(card.width, 1200);
  assert.equal(card.height, 630);
  assert.match(card.html, /Ship faster/);
  assert.ok(card.html.includes(HTML_THEMES.atris.color.bg), 'uses the theme background');
  assert.ok(card.html.includes(HTML_THEMES.atris.color.accent), 'uses the theme accent');
});

test('every size preset sets the right dimensions', () => {
  for (const [name, dim] of Object.entries(SIZES)) {
    const card = buildCard({ headline: 'x', size: name });
    assert.equal(card.width, dim.w);
    assert.equal(card.height, dim.h);
    assert.match(card.html, new RegExp(`width:${dim.w}px;height:${dim.h}px`));
  }
});

test('quote card renders the quote and attribution', () => {
  const card = buildCard({ kind: 'quote', text: 'It just works', by: 'a founder', size: 'square' });
  assert.match(card.html, /It just works/);
  assert.match(card.html, /a founder/);
  assert.match(card.html, /class="qtext"/);
});

test('stat card renders the number and label', () => {
  const card = buildCard({ kind: 'stat', number: '10x', label: 'faster reviews' });
  assert.match(card.html, /class="big"/);
  assert.match(card.html, /10x/);
  assert.match(card.html, /faster reviews/);
});

test('a project/brand theme flows into the card', () => {
  const themes = { ...HTML_THEMES, brand: normalizeTheme({ color: { accent: '#00A88F', bg: '#0B1410' } }) };
  const card = buildCard({ headline: 'On brand', theme: 'brand' }, { themes });
  assert.ok(card.html.includes('#00A88F'), 'uses the brand accent');
  assert.ok(card.html.includes('#0B1410'), 'uses the brand background');
  assert.equal(card.theme, 'brand');
});

test('unknown theme falls back to atris (never throws)', () => {
  const card = buildCard({ headline: 'hi', theme: 'does-not-exist' });
  assert.ok(card.html.includes(HTML_THEMES.atris.color.accent));
});

test('**emphasis** becomes an accent span', () => {
  const card = buildCard({ headline: 'made **on brand**' });
  assert.match(card.html, /<span class="accent">on brand<\/span>/);
});

test('anti-slop: an em dash in input never reaches the output', () => {
  const card = buildCard({ headline: 'fast — and clean', sub: 'one thing — done' });
  assert.ok(!card.html.includes('—'), 'no em dash in rendered card');
});

test('html is escaped (no raw angle brackets from input)', () => {
  const card = buildCard({ headline: '<script>x</script>' });
  assert.ok(!card.html.includes('<script>x'), 'input tags are escaped');
  assert.match(card.html, /&lt;script&gt;/);
});

test('KINDS and a long headline still produce valid output', () => {
  assert.deepEqual(KINDS, ['statement', 'quote', 'stat']);
  const long = 'a very long headline that should shrink to fit the card without overflowing the frame at all';
  const card = buildCard({ headline: long });
  assert.match(card.html, /font-size:\d+px/);
});
