const test = require('node:test');
const assert = require('node:assert/strict');
const { parseMarkdownToSpec, toColumn } = require('../lib/deck-from-md');
const { buildDeck } = require('../lib/slides-deck');

test('front matter sets theme, brand, accent', () => {
  const md = `---\ntheme: paper\nbrand: Sentinel\naccent: .\n---\n# Hi\n`;
  const spec = parseMarkdownToSpec(md);
  assert.equal(spec.theme, 'paper');
  assert.equal(spec.brand.name, 'Sentinel');
  assert.equal(spec.brand.accent, '.');
});

test('first H1 becomes a title slide with the following paragraph as sub', () => {
  const md = `# Read your incidents in the **dark.**\n\nOn-call shouldn't mean panic.\n`;
  const spec = parseMarkdownToSpec(md);
  assert.equal(spec.slides[0].type, 'title');
  assert.equal(spec.slides[0].headline, 'Read your incidents in the **dark.**');
  assert.equal(spec.slides[0].sub, "On-call shouldn't mean panic.");
});

test('H2 with 2-4 bullets becomes a columns slide', () => {
  const md = `# T\n\n## What makes it calm\n\n- **Ranked by impact** severity from real blast radius\n- **Quiet by default** one signal per incident\n- **Built for 3am** high contrast, keyboard first\n`;
  const spec = parseMarkdownToSpec(md);
  const cols = spec.slides.find((s) => s.type === 'columns');
  assert.ok(cols, 'expected a columns slide');
  assert.equal(cols.heading, 'What makes it calm');
  assert.equal(cols.columns.length, 3);
  assert.equal(cols.columns[0].h, 'Ranked by impact');
  assert.match(cols.columns[0].b, /blast radius/);
});

test('toColumn parses **Lead** rest, Lead: rest, and bare bullets', () => {
  assert.deepEqual(toColumn('**Fast** ships in seconds'), { h: 'Fast', b: 'ships in seconds' });
  assert.deepEqual(toColumn('Fast: ships in seconds'), { h: 'Fast', b: 'ships in seconds' });
  assert.deepEqual(toColumn('just a bullet'), { h: 'just a bullet', b: '' });
});

test('a single "**value** label" section becomes a bignumber slide', () => {
  const md = `# T\n\n## Impact\n\n**11 min** median time to first action\n`;
  const spec = parseMarkdownToSpec(md);
  const big = spec.slides.find((s) => s.type === 'bignumber');
  assert.ok(big, 'expected a bignumber slide');
  assert.equal(big.number, '11 min');
  assert.equal(big.label, 'median time to first action');
});

test('Close/CTA section becomes a close slide', () => {
  const md = `# T\n\n## Close\n\nRead your incidents in the dark.\n`;
  const spec = parseMarkdownToSpec(md);
  const close = spec.slides.find((s) => s.type === 'close');
  assert.ok(close);
  assert.equal(close.tagline, 'Read your incidents in the dark.');
});

test('plain H2 with a paragraph becomes a statement slide', () => {
  const md = `# T\n\n## On-call should not mean panic\n\nSo the console is calm by default.\n`;
  const spec = parseMarkdownToSpec(md);
  const st = spec.slides.find((s) => s.type === 'statement');
  assert.ok(st);
  assert.equal(st.text, 'On-call should not mean panic');
  assert.equal(st.sub, 'So the console is calm by default.');
});

test('the produced spec feeds buildDeck and emits one createSlide per slide', () => {
  const md = `---\ntheme: terminal\nbrand: Sentinel\n---\n# Hello **world**\n\nIntro line.\n\n## Three things\n\n- **A** one\n- **B** two\n- **C** three\n\n## Close\n\nThanks.\n`;
  const spec = parseMarkdownToSpec(md);
  const { requests } = buildDeck(spec);
  const creates = requests.filter((r) => r.createSlide).length;
  assert.equal(creates, spec.slides.length);
  assert.ok(spec.slides.length >= 3);
});

test('em dashes in the doc never reach a slide (engine sanitizes)', () => {
  const md = `# Fast, reliable — and calm\n\nShip it — today.\n`;
  const spec = parseMarkdownToSpec(md);
  const { requests } = buildDeck(spec);
  for (const r of requests) if (r.insertText) assert.ok(!r.insertText.text.includes('—'));
});

test('empty doc still yields a usable spec', () => {
  const spec = parseMarkdownToSpec('');
  assert.ok(spec.slides.length >= 1);
  assert.ok(spec.theme);
});
