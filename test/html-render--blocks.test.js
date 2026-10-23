const test = require('node:test');
const assert = require('node:assert/strict');
const { BLOCKS } = require('../lib/html-render');

test('BLOCKS.title renders a hero section with headline, sub, and brand mark', () => {
  const html = BLOCKS.title(
    { headline: 'Ship **fast**', sub: 'A subtitle.' },
    { brand: { name: 'Aurora', accent: '.' } },
  );
  assert.ok(html.includes('data-atris-block="hero"'));
  assert.ok(html.includes('<h1>Ship <span class="accent">fast</span></h1>'));
  assert.ok(html.includes('<div class="mark">Aurora<b>.</b></div>'));
  assert.ok(html.includes('<p class="sub">A subtitle.</p>'));
});

test('BLOCKS.statement escapes markup so injected HTML cannot run', () => {
  const html = BLOCKS.statement({ text: '<img src=x onerror=alert(1)>' });
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
});

test('BLOCKS.statement falls back to headline and sanitizes em dashes', () => {
  const html = BLOCKS.statement({ headline: 'one — two' });
  assert.ok(html.includes('<h2 class="big">one, two</h2>'));
  assert.ok(!html.includes('—'));
});

test('BLOCKS.columns caps the grid class at c4 and renders an empty grid for no columns', () => {
  const many = {
    heading: 'Six',
    columns: Array.from({ length: 6 }, (_, i) => ({ h: `H${i}`, b: `b${i}` })),
  };
  const html = BLOCKS.columns(many);
  assert.ok(html.includes('class="cols c4"'));
  assert.ok(html.includes('<h2 class="heading">Six</h2>'));
  assert.ok(html.includes('<h3>H5</h3>'));

  const none = BLOCKS.columns({});
  assert.ok(none.includes('class="cols c0"'));
  assert.ok(!none.includes('<div class="col">'));
});

test('BLOCKS.bignumber accepts value as a fallback for number', () => {
  const html = BLOCKS.bignumber({ value: 42, label: 'answers' });
  assert.ok(html.includes('data-atris-block="bignumber"'));
  assert.ok(html.includes('<div class="num">42</div>'));
  assert.ok(html.includes('<div class="num-label">answers</div>'));
});

test('BLOCKS.quote with an empty spec emits an empty blockquote and no cite', () => {
  const html = BLOCKS.quote({});
  assert.ok(html.includes('data-atris-block="quote"'));
  assert.ok(html.includes('<blockquote></blockquote>'));
  assert.ok(!html.includes('<cite>'));
});

test('BLOCKS.toc uses the item href as the title when title is missing', () => {
  const html = BLOCKS.toc({ items: [{ href: 'guide.html' }] });
  assert.ok(html.includes('<a class="toc-item" href="guide.html"><h3>guide.html</h3></a>'));
});

test('BLOCKS.close renders buttons only when provided and defaults the brand to Atris', () => {
  const withBtn = BLOCKS.close(
    { tagline: 'Go.', buttons: [{ label: 'Open', primary: true }] },
    { brand: { name: 'Aurora' } },
  );
  assert.ok(withBtn.includes('<a class="btn primary">Open</a>'));
  assert.ok(withBtn.includes('<p class="tagline">Go.</p>'));

  const bare = BLOCKS.close({}, {});
  assert.ok(!bare.includes('class="btns"'));
  assert.ok(bare.includes('<div class="mark">Atris</div>'));
});
