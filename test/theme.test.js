const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  loadProjectThemes, mergedThemes, normalizeTheme, isValidThemeShape, writeStarterTheme, BASE,
  buildTheme, themeWarnings, contrastRatio, bestOnColor, upsertProjectTheme, loadThemeRecipe, MOODS,
} = require('../lib/theme');
const { renderHtml, THEMES: HTML_THEMES } = require('../lib/html-render');
const { buildDeck, THEMES: DECK_THEMES, rgb } = require('../lib/slides-deck');
const themeCmd = require('../commands/theme');

// run a fn with cwd temporarily set to `dir` (the create/edit flow writes to process.cwd())
async function inDir(dir, fn) {
  const prev = process.cwd();
  process.chdir(dir);
  try { return await fn(); } finally { process.chdir(prev); }
}
function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'theme-')); }

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

// ---------- theme create: the guided generator ----------

test('buildTheme resolves a full theme from a mood + mode + accent', () => {
  const t = buildTheme({ mood: 'technical', mode: 'light', accent: '#3B82F6' });
  assert.equal(t.color.accent, '#3B82F6');
  assert.equal(t.color.bg, MOODS.technical.modes.light.bg); // surface from the mood
  assert.equal(t.fonts.display, 'Space Grotesk'); // technical => clean-sans
  assert.ok(t.color.accent2 && t.color.onAccent); // derived
  assert.equal(t.color.sev.length, 3);
});

test('buildTheme honors forceMode (noir is dark-only)', () => {
  const t = buildTheme({ mood: 'noir', mode: 'light' });
  assert.equal(t.color.bg, MOODS.noir.modes.dark.bg);
});

test('buildTheme with no answers gives a sensible editorial default', () => {
  const t = buildTheme();
  assert.equal(t.color.accent, MOODS.editorial.swatches[0]);
  assert.equal(t.color.bg, MOODS.editorial.modes.dark.bg);
});

test('buildTheme picks readable onAccent (contrast >= 4.5 with the accent)', () => {
  for (const mood of Object.keys(MOODS)) {
    const t = buildTheme({ mood });
    assert.ok(contrastRatio(t.color.onAccent, t.color.accent) >= 4.5, `${mood} onAccent unreadable`);
  }
});

test('contrastRatio: black/white ~21, identical color = 1', () => {
  assert.ok(Math.abs(contrastRatio('#000000', '#FFFFFF') - 21) < 0.1);
  assert.equal(Math.round(contrastRatio('#abcdef', '#abcdef')), 1);
  assert.equal(bestOnColor('#FFFFFF'), '#141110'); // dark ink on a light color
});

test('every built-in mood passes its own readability guard', () => {
  for (const mood of Object.keys(MOODS)) assert.deepEqual(themeWarnings(buildTheme({ mood })), []);
});

test('themeWarnings flags an unreadable theme', () => {
  const warns = themeWarnings({ color: { bg: '#FFFFFF', ink: '#F0F0F0', accent: '#FEFEFE', onAccent: '#FFFFFF' } });
  assert.ok(warns.length >= 2);
});

// ---------- upsertProjectTheme: save / preserve / migrate ----------

test('upsertProjectTheme creates then updates, preserving other themes', () => {
  const dir = tmp();
  const r1 = upsertProjectTheme('acme', buildTheme({ mood: 'technical', accent: '#3B82F6' }), dir);
  assert.equal(r1.action, 'created');
  upsertProjectTheme('acme-light', buildTheme({ mood: 'paper' }), dir);
  const r3 = upsertProjectTheme('acme', buildTheme({ mood: 'vivid', accent: '#8B5CF6' }), dir);
  assert.equal(r3.action, 'updated');
  assert.equal(r3.count, 2);
  const loaded = loadProjectThemes(dir);
  assert.equal(loaded.acme.color.accent, '#8B5CF6'); // updated
  assert.ok(loaded['acme-light']); // preserved
});

test('upsertProjectTheme migrates a single-theme file into the map form', () => {
  const dir = mkProject({ name: 'old', color: { accent: '#112233' } });
  upsertProjectTheme('fresh', buildTheme({ mood: 'noir' }), dir);
  const loaded = loadProjectThemes(dir);
  assert.ok(loaded.old, 'pre-existing single theme should be preserved');
  assert.ok(loaded.fresh);
});

test('upsertProjectTheme refuses to clobber an unparseable file (EBADTHEME)', () => {
  const dir = mkProject('{ not json at all');
  assert.throws(() => upsertProjectTheme('x', buildTheme(), dir), (e) => e.code === 'EBADTHEME');
});

test('a saved recipe round-trips for theme edit', () => {
  const dir = tmp();
  upsertProjectTheme('acme', buildTheme({ mood: 'vivid', accent: '#10B981' }), dir, { mood: 'vivid', mode: 'dark', accent: '#10B981' });
  const recipe = loadThemeRecipe('acme', dir);
  assert.equal(recipe.mood, 'vivid');
  assert.equal(recipe.accent, '#10B981');
});

// ---------- the command, non-interactive (flag-driven) ----------

test('theme create --flags writes .atris/theme.json with the new theme', async () => {
  const dir = tmp();
  const code = await inDir(dir, () => themeCmd.run(['create', 'acme', '--mood', 'technical', '--accent', '#3B82F6']));
  assert.equal(code, 0);
  const loaded = loadProjectThemes(dir);
  assert.ok(loaded.acme);
  assert.equal(loaded.acme.color.accent, '#3B82F6');
});

test('theme create rejects a bad hex / unknown mood', async () => {
  const dir = tmp();
  assert.equal(await inDir(dir, () => themeCmd.run(['create', 'x', '--accent', 'not-a-color'])), 2);
  assert.equal(await inDir(dir, () => themeCmd.run(['create', 'x', '--mood', 'banana'])), 2);
});

test('theme edit updates an existing theme via flags', async () => {
  const dir = tmp();
  await inDir(dir, () => themeCmd.run(['create', 'acme', '--mood', 'technical', '--accent', '#3B82F6']));
  const code = await inDir(dir, () => themeCmd.run(['edit', 'acme', '--accent', '#06B6D4']));
  assert.equal(code, 0);
  assert.equal(loadProjectThemes(dir).acme.color.accent, '#06B6D4');
});

test('theme edit on a missing theme errors', async () => {
  const dir = tmp();
  assert.equal(await inDir(dir, () => themeCmd.run(['edit', 'ghost'])), 2);
});

test('a created theme flows end-to-end into the HTML renderer', async () => {
  const dir = tmp();
  await inDir(dir, () => themeCmd.run(['create', 'brand', '--mood', 'technical', '--accent', '#3B82F6']));
  const themes = mergedThemes(HTML_THEMES, dir);
  const html = renderHtml({ theme: 'brand', brand: { name: 'X' }, slides: [{ type: 'title', headline: 'Hi' }] }, { themes });
  assert.match(html, /--brand-primary:#3B82F6/i);
});
