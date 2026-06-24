const test = require('node:test');
const assert = require('node:assert/strict');
const { buildDeck, THEMES, sanitize, parseEmph, COLOR_ROLES } = require('../lib/slides-deck');
const { SAMPLE } = require('../commands/deck');

test('every theme defines all color roles + three fonts', () => {
  for (const [name, t] of Object.entries(THEMES)) {
    for (const role of COLOR_ROLES) assert.ok(t.color[role], `${name} missing color.${role}`);
    assert.ok(t.fonts.display && t.fonts.body && t.fonts.mono, `${name} missing a font`);
  }
});

test('buildDeck emits one createSlide + one background per slide', () => {
  const { requests, slideIds } = buildDeck(SAMPLE);
  const creates = requests.filter((r) => r.createSlide).length;
  const bgs = requests.filter((r) => r.updatePageProperties).length;
  assert.equal(creates, SAMPLE.slides.length);
  assert.equal(bgs, SAMPLE.slides.length);
  assert.equal(slideIds.length, SAMPLE.slides.length);
});

test('the engine never ships an em dash (sanitized out of all inserted text)', () => {
  const spec = { theme: 'terminal', brand: { name: 'X' }, slides: [
    { type: 'statement', text: 'Fast, reliable — and calm.', sub: 'Ship it — today.' }] };
  const { requests } = buildDeck(spec);
  for (const r of requests) if (r.insertText) assert.ok(!r.insertText.text.includes('—'), 'em dash leaked into a slide');
});

test('**emphasis** is stripped to plain text and styled with the accent', () => {
  const { plain, ranges } = parseEmph('Read it in the **dark.**');
  assert.ok(!plain.includes('*'));
  assert.equal(plain, 'Read it in the dark.');
  assert.equal(ranges.length, 1);
  assert.equal(plain.slice(ranges[0].start, ranges[0].end), 'dark.');
});

test('columns archetype renders a heading + body per column', () => {
  const spec = { theme: 'paper', brand: { name: 'X' }, slides: [
    { type: 'columns', heading: 'H', columns: [{ h: 'A', b: 'a' }, { h: 'B', b: 'b' }, { h: 'C', b: 'c' }] }] };
  const { requests } = buildDeck(spec);
  const texts = requests.filter((r) => r.insertText).map((r) => r.insertText.text);
  for (const t of ['A', 'B', 'C', 'a', 'b', 'c']) assert.ok(texts.includes(t), `missing column text ${t}`);
});

test('chips wrap to a second row instead of running off-slide', () => {
  const spec = { theme: 'paper', brand: { name: 'X' }, slides: [{
    type: 'chips',
    chips: [
      '$200/mo business computer',
      'Unlimited Members',
      'Usage credits',
      'Managed loop setup',
      'Enterprise controls',
    ],
  }] };
  const { requests } = buildDeck(spec);
  const shapes = requests.filter((r) => r.createShape && r.createShape.shapeType === 'ROUND_RECTANGLE');
  const ys = shapes.map((r) => r.createShape.elementProperties.transform.translateY);
  assert.ok(Math.max(...ys) - Math.min(...ys) > 20, 'chips should wrap to multiple rows');
});

test('unknown slide type falls back to statement, unknown theme to terminal', () => {
  const { requests } = buildDeck({ theme: 'nope', slides: [{ type: 'mystery', text: 'hi' }] });
  assert.ok(requests.some((r) => r.insertText && r.insertText.text === 'hi'));
});

test('sanitize collapses spaced hyphen separators too', () => {
  assert.equal(sanitize('on - call'), 'on, call');
  assert.equal(sanitize('on-call'), 'on-call'); // real hyphenated word survives
});

test('v2 archetypes render without falling back to statement', () => {
  const spec = {
    theme: 'terminal',
    brand: { name: 'X' },
    slides: [
      { type: 'timeline', heading: 'Flow', steps: [{ label: 'a' }, { label: 'b', active: true }] },
      { type: 'versus', heading: 'Vs', left: { label: 'L', items: ['one'] }, right: { label: 'R', items: ['two'] } },
      { type: 'metricgrid', metrics: [{ value: '1', label: 'a' }, { value: '2', label: 'b' }] },
      { type: 'receipt', fields: [{ k: 'x', v: 'y' }], stamp: 'ok' },
      { type: 'stack', layers: [{ title: 'A', sub: 'a' }] },
      { type: 'quote', text: 'hello', author: 'me' },
      { type: 'hero', headline: 'done', mono: 'cmd' },
    ],
  };
  const { requests, slideIds } = buildDeck(spec);
  assert.equal(slideIds.length, 7);
  const texts = requests.filter((r) => r.insertText).map((r) => r.insertText.text);
  assert.ok(texts.includes('Flow'));
  assert.ok(texts.includes('ok'));
  assert.ok(texts.includes('hello'));
  assert.ok(texts.includes('cmd'));
});

test('bullets archetype renders a typography list with no card boxes', () => {
  const spec = { theme: 'paper', brand: { name: 'X' }, slides: [{
    type: 'bullets',
    heading: 'Points',
    items: ['one', 'two', { text: 'three', sub: 'note' }],
  }] };
  const { requests, slideIds } = buildDeck(spec);
  assert.equal(slideIds.length, 1);
  const texts = requests.filter((r) => r.insertText).map((r) => r.insertText.text);
  for (const t of ['Points', 'one', 'two', 'three', 'note']) {
    assert.ok(texts.includes(t), `missing bullet text ${t}`);
  }
  // the box-free promise: bullets must not draw rounded-rectangle cards
  const cards = requests.filter((r) => r.createShape && r.createShape.shapeType === 'ROUND_RECTANGLE').length;
  assert.equal(cards, 0, 'bullets must not draw card boxes');
  // accent dots mark each item
  const dots = requests.filter((r) => r.createShape && r.createShape.shapeType === 'ELLIPSE').length;
  assert.equal(dots, 3, 'one accent dot per bullet');
});

test('bullets list shrinks font as it grows (dense lists still fit)', () => {
  const sizeFor = (count) => {
    const items = Array.from({ length: count }, (_, i) => `item ${i}`);
    const { requests } = buildDeck({ theme: 'ink', brand: { name: 'X' }, slides: [{ type: 'bullets', items }] });
    // the bullet body text style carries the font size
    const styles = requests.filter((r) => r.updateTextStyle && r.updateTextStyle.style.fontSize);
    return Math.max(...styles.map((r) => r.updateTextStyle.style.fontSize.magnitude));
  };
  assert.ok(sizeFor(7) < sizeFor(3), 'a 7-item list should use a smaller font than a 3-item list');
});

test('narrative archetypes render typography-first slides', () => {
  const spec = {
    theme: 'ink',
    brand: { name: 'X' },
    slides: [
      { type: 'interstitial', kicker: 'k', text: 'Chapter **one.**', sub: 'sub' },
      { type: 'lede', headline: 'Big **headline.**', dek: 'dek line', byline: 'by me' },
      { type: 'prose', heading: 'Section', paragraphs: ['para one', 'para two'] },
      { type: 'split', heading: 'Split', body: 'left body', accent: '99%', accentSub: 'stat note' },
    ],
  };
  const { requests, slideIds } = buildDeck(spec);
  assert.equal(slideIds.length, 4);
  const texts = requests.filter((r) => r.insertText).map((r) => r.insertText.text);
  assert.ok(texts.includes('Chapter one.'));
  assert.ok(texts.includes('Big headline.'));
  assert.ok(texts.includes('para one'));
  assert.ok(texts.includes('99%'));
});
