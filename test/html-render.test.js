const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { renderHtml, renderBlock, THEMES } = require('../lib/html-render');
const { parseMarkdownToSpec } = require('../lib/deck-from-md');
const { scanFile } = require('../commands/slop');

const SPEC = {
  theme: 'atris', brand: { name: 'Aurora', accent: '.' },
  slides: [
    { type: 'title', headline: 'Beautiful **HTML**', sub: 'Same content model, new renderer.',
      panel: { header: { title: 'Active', meta: 'live' }, rows: [{ title: 'A', sub: 'x', value: '42%', sev: 0, active: true }] } },
    { type: 'columns', heading: 'Why', columns: [{ h: 'One', b: 'first' }, { h: 'Two', b: 'second' }] },
    { type: 'bignumber', number: '90 sec', label: 'to a page' },
    { type: 'quote', text: 'It just works.', by: 'a PM' },
    { type: 'close', tagline: 'Ship it.', buttons: [{ label: 'Open', primary: true }], footer: 'atris.ai' },
  ],
};

test('renderHtml emits a full document with a section per block', () => {
  const html = renderHtml(SPEC);
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<\/html>\s*$/);
  for (const t of ['hero', 'columns', 'bignumber', 'quote', 'close']) {
    assert.ok(html.includes(`data-atris-block="${t}"`), `missing block ${t}`);
  }
});

test('the atris theme matches atrisos-web tokens (amber + warm dark, --brand-*)', () => {
  const html = renderHtml({ ...SPEC, theme: 'atris' });
  assert.match(html, /--brand-primary:#F59E0B/i);
  assert.match(html, /--brand-bg:#141110/i);
  assert.match(html, /TWKLausanne/);
  assert.ok(THEMES.atris && THEMES.atris.color.accent.toUpperCase() === '#F59E0B');
});

test('**emphasis** renders as an accent span', () => {
  const html = renderHtml(SPEC);
  assert.match(html, /<span class="accent">HTML<\/span>/);
});

test('content is HTML-escaped (no injection)', () => {
  const html = renderHtml({ theme: 'atris', brand: { name: 'X' }, slides: [{ type: 'statement', text: '<script>alert(1)</script>' }] });
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.match(html, /&lt;script&gt;/);
});

test('renderBlock emits the AppBlock html shape for embedding in an app', () => {
  const block = renderBlock(SPEC, { title: 'Aurora deck' });
  assert.equal(block.type, 'html');
  assert.equal(block.config.block_type, 'html');
  assert.match(block.config.html, /^<!doctype html>/);
  assert.equal(block.title, 'Aurora deck');
});

test('generated HTML passes the slop gate (anti-slop by construction)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'html-'));
  for (const theme of ['atris', 'terminal', 'paper']) {
    const file = path.join(dir, `page-${theme}.html`);
    fs.writeFileSync(file, renderHtml({ ...SPEC, theme }));
    const findings = scanFile(file);
    assert.equal(findings.length, 0, `${theme}: ${findings.map((f) => f.rule).join(', ')}`);
  }
});

test('markdown -> spec -> HTML round trips', () => {
  const md = `---\ntheme: atris\nbrand: Sentinel\n---\n# Hello **world**\n\nIntro.\n\n## Three\n\n- **A** one\n- **B** two\n- **C** three\n`;
  const html = renderHtml(parseMarkdownToSpec(md));
  assert.match(html, /Sentinel/);
  assert.ok(html.includes('data-atris-block="columns"'));
  assert.ok(!html.includes('—'));
});
