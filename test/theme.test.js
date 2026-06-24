const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadProjectThemes, mergedThemes, normalizeTheme, isValidThemeShape, writeStarterTheme, BASE } = require('../lib/theme');
const { renderHtml, THEMES: HTML_THEMES } = require('../lib/html-render');
const { buildDeck, THEMES: DECK_THEMES, rgb } = require('../lib/slides-deck');

function mkProject(json) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'theme-'));
  if (json != null) {
    fs.mkdirSync(path.join(dir, '.atris'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.atris', 'theme.json'), typeof json === 'string' ? json : JSON.stringify(json));
  }
  return dir;
}

test('normalizeTheme inherits every missing token from the base', () => {
  const t = normalizeTheme({ color: { accent: '#00A88F' } });
  assert.equal(t.color.accent, '#00A88F');
  assert.equal(t.color.bg, BASE.color.bg); // inherited
  assert.equal(t.fonts.display, BASE.fonts.display); // inherited
});

test('isValidThemeShape requires color or fonts', () => {
  assert.ok(isValidThemeShape({ color: { accent: '#fff' } }));
  assert.ok(isValidThemeShape({ fonts: { display: 'Fraunces' } }));
  assert.ok(!isValidThemeShape({}));
  assert.ok(!isValidThemeShape(null));
});

test('loadProjectThemes reads the single-theme and themes-map forms', () => {
  const single = loadProjectThemes(mkProject({ name: 'acme', color: { accent: '#112233' } }));
  assert.ok(single.acme);
  assert.equal(single.acme.color.accent, '#112233');

  const many = loadProjectThemes(mkProject({ themes: { a: { color: { accent: '#aa0000' } }, b: { color: { accent: '#00bb00' } } } }));
  assert.equal(Object.keys(many).length, 2);
  assert.equal(many.a.color.accent, '#aa0000');
});

test('a broken theme.json degrades to no project themes (not fatal)', () => {
  assert.deepEqual(loadProjectThemes(mkProject('{ not json')), {});
  assert.deepEqual(loadProjectThemes(mkProject({ themes: { bad: {} } })), {}); // empty theme skipped
});

test('mergedThemes lets a project theme override a built-in by name', () => {
  const dir = mkProject({ themes: { atris: { color: { accent: '#FF0000' } } } });
  const merged = mergedThemes(HTML_THEMES, dir);
  assert.equal(merged.atris.color.accent, '#FF0000'); // project wins
  assert.equal(merged.terminal.color.accent, HTML_THEMES.terminal.color.accent); // others intact
});

test('a project theme flows into the HTML renderer', () => {
  const dir = mkProject({ name: 'brand', color: { accent: '#00A88F', bg: '#0B1410' } });
  const themes = mergedThemes(HTML_THEMES, dir);
  const html = renderHtml({ theme: 'brand', brand: { name: 'X' }, slides: [{ type: 'title', headline: 'Hi' }] }, { themes });
  assert.match(html, /--brand-primary:#00A88F/i);
  assert.match(html, /--brand-bg:#0B1410/i);
});

test('a project theme flows into the deck renderer', () => {
  const dir = mkProject({ name: 'brand', color: { accent: '#00A88F' } });
  const themes = { ...DECK_THEMES, ...loadProjectThemes(dir) };
  const { requests } = buildDeck({ theme: 'brand', brand: { name: 'X' }, slides: [{ type: 'bignumber', number: '9' }] }, { themes });
  const accent = rgb('#00A88F');
  const usesAccent = JSON.stringify(requests).includes(JSON.stringify(accent.red).slice(0, 6));
  assert.ok(usesAccent, 'the deck should use the project accent color');
});

test('writeStarterTheme scaffolds .atris/theme.json idempotently', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'theme-init-'));
  const r1 = writeStarterTheme(dir);
  assert.equal(r1.already, false);
  assert.ok(fs.existsSync(r1.file));
  assert.equal(writeStarterTheme(dir).already, true);
  assert.ok(loadProjectThemes(dir).brand);
});
