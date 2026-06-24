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

module.exports = { BASE, COLOR_ROLES, normalizeTheme, isValidThemeShape, loadProjectThemes, mergedThemes, writeStarterTheme, PROJECT_THEME_FILE };
