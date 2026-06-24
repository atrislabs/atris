// Brand themes — a project defines its own theme in .atris/theme.json and every
// renderer (deck, HTML, site, memory view) uses it. Compounds like slop rules:
// describe your brand once, every deck and page is on-brand.
//
// theme.json shapes (both accepted):
//   { "color": { "accent": "#00A88F", "bg": "#0B1410" }, "fonts": { "display": "Fraunces" } }
//   { "themes": { "acme": { "color": {...} }, "acme-light": { "color": {...} } } }
// Partial themes inherit every missing token from the base (a full warm-dark theme).

const fs = require('fs');
const path = require('path');

const PROJECT_THEME_FILE = path.join('.atris', 'theme.json');

// full base so a project can define just an accent + bg and inherit the rest
const BASE = {
  fonts: { display: 'Fraunces', body: 'Outfit', mono: 'ui-monospace, SFMono-Regular, monospace' },
  color: {
    bg: '#141110', panel: '#1E1915', panelAlt: '#2C2520', line: '#3D332D',
    ink: '#EAE3D9', soft: '#A39B92', faint: '#7C736B',
    accent: '#F59E0B', accent2: '#FBBF24', onAccent: '#141110',
    sev: ['#F59E0B', '#FBBF24', '#7F97A4'],
  },
};

const COLOR_ROLES = ['bg', 'panel', 'panelAlt', 'line', 'ink', 'soft', 'faint', 'accent', 'accent2', 'onAccent'];

function normalizeTheme(t, base = BASE) {
  const src = t && typeof t === 'object' ? t : {};
  return {
    fonts: { ...base.fonts, ...(src.fonts || {}) },
    color: { ...base.color, ...(src.color || {}), sev: (src.color && src.color.sev) || base.color.sev },
  };
}

function isValidThemeShape(t) {
  if (!t || typeof t !== 'object') return false;
  const hasColor = t.color && typeof t.color === 'object';
  const hasFonts = t.fonts && typeof t.fonts === 'object';
  return Boolean(hasColor || hasFonts);
}

// returns { name: normalizedTheme } from .atris/theme.json (or {} if none/bad)
function loadProjectThemes(root = process.cwd()) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(path.join(root, PROJECT_THEME_FILE), 'utf8')); }
  catch { return {}; }
  const out = {};
  if (raw && raw.themes && typeof raw.themes === 'object') {
    for (const [name, t] of Object.entries(raw.themes)) if (isValidThemeShape(t)) out[name] = normalizeTheme(t);
  } else if (isValidThemeShape(raw)) {
    out[raw.name || 'brand'] = normalizeTheme(raw);
  }
  return out;
}

// merge built-in themes with project themes (project wins on name collision)
function mergedThemes(builtin, root = process.cwd()) {
  return { ...builtin, ...loadProjectThemes(root) };
}

function writeStarterTheme(root = process.cwd()) {
  const file = path.join(root, PROJECT_THEME_FILE);
  if (fs.existsSync(file)) return { file, already: true };
  const starter = {
    name: 'brand',
    color: { accent: '#00A88F', accent2: '#3FD0B6', bg: '#0B1410', ink: '#E8F0EC' },
    fonts: { display: 'Fraunces', body: 'Outfit' },
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(starter, null, 2) + '\n');
  return { file, already: false };
}

// ---------- color math (WCAG contrast — the tasteful guardrail) ----------
function hexToRgb(hex) {
  const h = String(hex == null ? '' : hex).trim().replace(/^#/, '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return null;
  return { r: parseInt(full.slice(0, 2), 16), g: parseInt(full.slice(2, 4), 16), b: parseInt(full.slice(4, 6), 16) };
}

function isHex(hex) { return hexToRgb(hex) != null; }

function normHex(hex) {
  const c = hexToRgb(hex);
  if (!c) return null;
  return '#' + [c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();
}

function relLuminance(hex) {
  const c = hexToRgb(hex);
  if (!c) return 0;
  const lin = [c.r, c.g, c.b].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

function contrastRatio(a, b) {
  const hi = Math.max(relLuminance(a), relLuminance(b));
  const lo = Math.min(relLuminance(a), relLuminance(b));
  return (hi + 0.05) / (lo + 0.05);
}

// the readable ink to drop on top of a solid color (near-black vs near-white)
function bestOnColor(hex, dark = '#141110', light = '#FFFFFF') {
  return contrastRatio(hex, dark) >= contrastRatio(hex, light) ? dark : light;
}

// blend two hex colors, t in [0,1] toward `b`
function mix(a, b, t) {
  const ca = hexToRgb(a), cb = hexToRgb(b);
  if (!ca || !cb) return normHex(a) || '#000000';
  const m = (x, y) => Math.round(x + (y - x) * t);
  return '#' + [m(ca.r, cb.r), m(ca.g, cb.g), m(ca.b, cb.b)].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();
}

// ---------- the tasteful vocabulary (moods, fonts) used by `atris theme create` ----------
const FONT_PERSONALITIES = {
  'editorial-serif': { display: 'Fraunces', body: 'Outfit', mono: 'IBM Plex Mono' },
  'clean-sans': { display: 'Space Grotesk', body: 'Outfit', mono: 'IBM Plex Mono' },
  'mono-forward': { display: 'Space Grotesk', body: 'IBM Plex Mono', mono: 'IBM Plex Mono' },
};

// each mood is hand-tuned neutral scaffolding + a font pairing + curated accents.
// the user picks a feeling; we keep the surface tasteful and let their accent lead.
const MOODS = {
  editorial: {
    blurb: 'warm, literary, considered — Fraunces headlines on calm paper',
    defaultMode: 'dark', fonts: 'editorial-serif',
    swatches: ['#B5572E', '#D98E5C', '#9E3B2E', '#C08552'],
    modes: {
      dark:  { bg: '#1E1A16', panel: '#261F19', panelAlt: '#322820', line: '#443629', ink: '#EDE4D6', soft: '#B0A595', faint: '#837868' },
      light: { bg: '#FBF8F2', panel: '#F2ECE0', panelAlt: '#E9E1D2', line: '#DCD2C0', ink: '#2A241D', soft: '#6B6256', faint: '#938A7C' },
    },
  },
  technical: {
    blurb: 'cool, precise, engineered — Space Grotesk on slate, mono accents',
    defaultMode: 'dark', fonts: 'clean-sans',
    swatches: ['#3B82F6', '#06B6D4', '#6366F1', '#14B8A6'],
    modes: {
      dark:  { bg: '#0E1116', panel: '#161B22', panelAlt: '#1C2330', line: '#2A3340', ink: '#E6EDF3', soft: '#9DA7B3', faint: '#6B7682' },
      light: { bg: '#F7F9FB', panel: '#EEF2F6', panelAlt: '#E3E9F0', line: '#D2DAE3', ink: '#1A2230', soft: '#5A6675', faint: '#8A95A3' },
    },
  },
  noir: {
    blurb: 'high-contrast, near-black, one electric accent — confident and stark',
    defaultMode: 'dark', forceMode: 'dark', fonts: 'clean-sans',
    swatches: ['#C8FF00', '#FF2D78', '#FFB000', '#7DD3FC'],
    modes: {
      dark: { bg: '#0A0A0B', panel: '#131316', panelAlt: '#1B1B20', line: '#2A2A30', ink: '#F4F4F5', soft: '#A1A1AA', faint: '#6E6E76' },
    },
  },
  paper: {
    blurb: 'calm, light, low-key — ink on cream, nothing shouting',
    defaultMode: 'light', forceMode: 'light', fonts: 'editorial-serif',
    swatches: ['#2F4858', '#5B7553', '#B5572E', '#6B4E71'],
    modes: {
      light: { bg: '#FBF8F2', panel: '#F2ECE0', panelAlt: '#E9E1D2', line: '#DCD2C0', ink: '#2A241D', soft: '#6B6256', faint: '#938A7C' },
    },
  },
  vivid: {
    blurb: 'saturated, playful, energetic — a bold accent that carries the page',
    defaultMode: 'dark', fonts: 'clean-sans',
    swatches: ['#FF5C5C', '#8B5CF6', '#10B981', '#F59E0B'],
    modes: {
      dark:  { bg: '#121016', panel: '#1B1822', panelAlt: '#251F30', line: '#352C42', ink: '#F2EEF7', soft: '#ADA3BC', faint: '#7D7388' },
      light: { bg: '#FCFAFF', panel: '#F3EFF9', panelAlt: '#E9E2F2', line: '#DAD0E6', ink: '#221B2C', soft: '#645A72', faint: '#938A9F' },
    },
  },
};

const MOOD_NAMES = Object.keys(MOODS);

function resolveFonts(spec, mood) {
  const m = MOODS[mood] || MOODS.editorial;
  if (spec && typeof spec === 'object') return { ...FONT_PERSONALITIES[m.fonts], ...spec };
  const key = spec && FONT_PERSONALITIES[spec] ? spec : m.fonts;
  return { ...FONT_PERSONALITIES[key] };
}

function resolveMode(mood, mode) {
  const m = MOODS[mood] || MOODS.editorial;
  if (m.forceMode) return m.forceMode;
  if ((mode === 'light' || mode === 'dark') && m.modes[mode]) return mode;
  return m.defaultMode;
}

// pure: tasteful answers -> a full, normalized theme. The heart of `atris theme create`.
//   answers = { mood, mode?, accent?, accent2?, fonts? }
function buildTheme(answers = {}) {
  const moodKey = MOODS[answers.mood] ? answers.mood : 'editorial';
  const mood = MOODS[moodKey];
  const mode = resolveMode(moodKey, answers.mode);
  const surface = mood.modes[mode];

  const accent = normHex(answers.accent) || mood.swatches[0];
  const accent2 = normHex(answers.accent2) || mix(accent, surface.ink, 0.28);
  const onAccent = bestOnColor(accent);
  const fonts = resolveFonts(answers.fonts, moodKey);

  return normalizeTheme({
    color: { ...surface, accent, accent2, onAccent, sev: [accent, accent2, surface.faint] },
    fonts,
  });
}

// readability guardrail — human messages for low-contrast choices (empty array = clean)
function themeWarnings(theme) {
  const c = normalizeTheme(theme).color;
  const warn = [];
  const body = contrastRatio(c.ink, c.bg);
  if (body < 4.5) warn.push(`body text (ink on bg) is ${body.toFixed(1)}:1 — below the 4.5:1 readable floor`);
  const onAcc = contrastRatio(c.onAccent, c.accent);
  if (onAcc < 4.5) warn.push(`text on the accent is ${onAcc.toFixed(1)}:1 — below 4.5:1`);
  const accentBg = contrastRatio(c.accent, c.bg);
  if (accentBg < 2.0) warn.push(`the accent barely separates from the background (${accentBg.toFixed(1)}:1) — pick a bolder color`);
  return warn;
}

// write/replace a named theme in .atris/theme.json (always the themes-map form),
// preserving every other theme. Throws (code EBADTHEME) if an existing file is present
// but unparseable, so we never clobber a hand-edited brand file.
function upsertProjectTheme(name, theme, root = process.cwd(), recipe = null) {
  const themeName = (String(name == null ? '' : name).trim()) || 'brand';
  const file = path.join(root, PROJECT_THEME_FILE);
  let themes = {};
  if (fs.existsSync(file)) {
    let raw;
    try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch { const e = new Error(`${PROJECT_THEME_FILE} is not valid JSON — fix or remove it before saving`); e.code = 'EBADTHEME'; throw e; }
    if (raw && raw.themes && typeof raw.themes === 'object') themes = { ...raw.themes };
    else if (isValidThemeShape(raw)) themes[raw.name || 'brand'] = { name: raw.name, color: raw.color, fonts: raw.fonts };
  }
  const existed = Object.prototype.hasOwnProperty.call(themes, themeName);
  const t = normalizeTheme(theme);
  // recipe = the high-level answers (mood/mode/accent); inert to renderers, lets `theme edit` re-seed
  const record = { name: themeName };
  if (recipe && typeof recipe === 'object') record.recipe = recipe;
  record.color = t.color; record.fonts = t.fonts;
  themes[themeName] = record;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ themes }, null, 2) + '\n');
  return { file, name: themeName, action: existed ? 'updated' : 'created', count: Object.keys(themes).length };
}

// the saved high-level answers for a theme, if present (for `theme edit` pre-fill)
function loadThemeRecipe(name, root = process.cwd()) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(path.join(root, PROJECT_THEME_FILE), 'utf8')); }
  catch { return null; }
  const rec = raw && raw.themes && raw.themes[name];
  return rec && rec.recipe && typeof rec.recipe === 'object' ? rec.recipe : null;
}

module.exports = {
  BASE, COLOR_ROLES, normalizeTheme, isValidThemeShape, loadProjectThemes, mergedThemes,
  writeStarterTheme, PROJECT_THEME_FILE,
  hexToRgb, isHex, normHex, relLuminance, contrastRatio, bestOnColor, mix,
  FONT_PERSONALITIES, MOODS, MOOD_NAMES, resolveFonts, resolveMode,
  buildTheme, themeWarnings, upsertProjectTheme, loadThemeRecipe,
};
