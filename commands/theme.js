// atris theme — brand themes for the whole design system. Define your colors and
// fonts once in .atris/theme.json; every deck, HTML page, and site uses them.
//
//   atris theme create        guided interview -> your own theme (alias: new)
//   atris theme edit <name>   re-run the interview to tweak an existing theme
//   atris theme init          scaffold a starter .atris/theme.json
//   atris theme list          list built-in + project themes
//   atris theme show <name>   print a resolved theme

const readline = require('readline');
const {
  mergedThemes, writeStarterTheme, loadProjectThemes, loadThemeRecipe, PROJECT_THEME_FILE,
  MOODS, MOOD_NAMES, FONT_PERSONALITIES, buildTheme, themeWarnings, upsertProjectTheme,
  resolveMode, isHex, normHex, hexToRgb,
} = require('../lib/theme');
const { THEMES: HTML_THEMES } = require('../lib/html-render');

// ---------- small terminal helpers ----------
function parseFlags(argv) {
  const flags = {}; const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-y' || a === '--yes') { flags.yes = true; continue; }
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next != null && !next.startsWith('--')) { flags[key] = next; i++; }
      else flags[key] = true;
      continue;
    }
    pos.push(a);
  }
  return { flags, pos };
}

// a colored block when we're on a real terminal, two blank cells otherwise (clean pipes)
function sw(hex) {
  const c = hexToRgb(hex);
  if (!c || !process.stdout.isTTY) return '  ';
  return `\x1b[48;2;${c.r};${c.g};${c.b}m  \x1b[0m`;
}

function printPreview(name, answers, theme) {
  const c = theme.color;
  const mode = resolveMode(answers.mood || 'editorial', answers.mode);
  console.log(`\n  ${name}  ·  ${answers.mood || 'editorial'} ${mode}`);
  const row = (label, hex) => console.log(`   ${sw(hex)} ${label.padEnd(8)} ${hex}`);
  row('bg', c.bg);
  row('ink', c.ink);
  row('accent', c.accent);
  row('accent2', c.accent2);
  console.log(`      ${theme.fonts.display} display, ${theme.fonts.body} body`);
}

// ---------- the guided interview (tasteful vocabulary) ----------
async function interview(defaults = {}) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((res) => rl.question(q, res));
  const ans = {};
  try {
    console.log('\n  let\'s make your theme. five quick choices, all changeable later.\n');

    const dn = defaults.name || 'brand';
    ans.name = (await ask(`  1/5  name it [${dn}]: `)).trim() || dn;

    console.log('\n  2/5  what should it feel like?');
    MOOD_NAMES.forEach((m, i) => console.log(`     ${i + 1}. ${m.padEnd(10)} ${MOODS[m].blurb}`));
    const dmIdx = Math.max(0, MOOD_NAMES.indexOf(defaults.mood || 'editorial'));
    const moodPick = (await ask(`     pick 1-${MOOD_NAMES.length} [${dmIdx + 1}]: `)).trim();
    ans.mood = MOOD_NAMES[(parseInt(moodPick, 10) - 1)] || MOOD_NAMES[dmIdx];
    const mood = MOODS[ans.mood];

    if (mood.forceMode) {
      ans.mode = mood.forceMode;
      console.log(`     (${ans.mood} is ${mood.forceMode}-only)`);
    } else {
      const dmode = defaults.mode || mood.defaultMode;
      const mp = (await ask(`\n  3/5  light or dark? [${dmode[0]}]: `)).trim().toLowerCase();
      ans.mode = mp.startsWith('l') ? 'light' : mp.startsWith('d') ? 'dark' : dmode;
    }

    console.log('\n  4/5  your accent — the one color that is unmistakably yours:');
    mood.swatches.forEach((s, i) => console.log(`     ${i + 1}. ${sw(s)} ${s}`));
    const dac = normHex(defaults.accent) || mood.swatches[0];
    const ap = (await ask(`     pick 1-${mood.swatches.length}, or paste a hex [${dac}]: `)).trim();
    if (!ap) ans.accent = dac;
    else if (/^[1-9]$/.test(ap) && mood.swatches[parseInt(ap, 10) - 1]) ans.accent = mood.swatches[parseInt(ap, 10) - 1];
    else if (isHex(ap)) ans.accent = normHex(ap);
    else { console.log(`     '${ap}' is not 1-${mood.swatches.length} or a hex, keeping ${dac}`); ans.accent = dac; }

    console.log('\n  5/5  type personality:');
    const fontKeys = Object.keys(FONT_PERSONALITIES);
    fontKeys.forEach((k, i) => console.log(`     ${i + 1}. ${k.padEnd(15)} ${FONT_PERSONALITIES[k].display} / ${FONT_PERSONALITIES[k].body}`));
    const dfIdx = fontKeys.indexOf(typeof defaults.fonts === 'string' ? defaults.fonts : mood.fonts);
    const fp = (await ask(`     pick 1-${fontKeys.length} [${(dfIdx < 0 ? 0 : dfIdx) + 1}]: `)).trim();
    ans.fonts = fontKeys[(parseInt(fp, 10) - 1)] || fontKeys[dfIdx < 0 ? 0 : dfIdx];
  } finally {
    rl.close();
  }
  return ans;
}

function confirmSync(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(q, (a) => { rl.close(); res(!String(a).trim().toLowerCase().startsWith('n')); }));
}

// shared create/edit flow. defaults seed an edit; flags override anything; interactive
// only when there's a TTY and no defining flags.
async function createFlow({ name, defaults = {}, flags }) {
  const answers = { ...defaults };
  if (flags.mood) answers.mood = flags.mood;
  if (flags.mode) answers.mode = flags.mode;
  if (flags.accent) answers.accent = flags.accent;
  if (flags.accent2) answers.accent2 = flags.accent2;
  if (flags.fonts) answers.fonts = flags.fonts;
  let themeName = name || flags.name || defaults.name || 'brand';

  const hasDefiningFlag = Boolean(flags.mood || flags.mode || flags.accent || flags.accent2 || flags.fonts || flags.name);
  const interactive = Boolean(process.stdin.isTTY) && !flags.yes && !hasDefiningFlag;

  if (interactive) {
    const r = await interview({ name: themeName, ...answers });
    Object.assign(answers, r);
    themeName = r.name || themeName;
  }
  themeName = String(themeName).trim() || 'brand';

  if (answers.mood && !MOODS[answers.mood]) { console.error(`  unknown mood "${answers.mood}". try: ${MOOD_NAMES.join(', ')}`); return 2; }
  if (answers.accent && !isHex(answers.accent)) { console.error(`  not a hex color: ${answers.accent}`); return 2; }
  if (answers.accent2 && !isHex(answers.accent2)) { console.error(`  not a hex color: ${answers.accent2}`); return 2; }
  if (answers.fonts && typeof answers.fonts === 'string' && !FONT_PERSONALITIES[answers.fonts]) {
    console.error(`  unknown font personality "${answers.fonts}". try: ${Object.keys(FONT_PERSONALITIES).join(', ')}`); return 2;
  }

  const theme = buildTheme(answers);
  printPreview(themeName, answers, theme);
  const warns = themeWarnings(theme);
  if (warns.length) { console.log('\n  heads up:'); warns.forEach((w) => console.log(`   ! ${w}`)); }

  if (interactive) {
    const ok = await confirmSync('\n  save this theme? [enter = yes, n = cancel] ');
    if (!ok) { console.log('  cancelled, nothing written.\n'); return 0; }
  }

  const recipe = {
    mood: answers.mood || 'editorial',
    mode: resolveMode(answers.mood || 'editorial', answers.mode),
    accent: theme.color.accent,
    accent2: theme.color.accent2,
    fonts: typeof answers.fonts === 'string' ? answers.fonts : (MOODS[answers.mood || 'editorial'].fonts),
  };

  let res;
  try { res = upsertProjectTheme(themeName, theme, process.cwd(), recipe); }
  catch (e) { console.error(`  ${e.message}`); return 1; }

  console.log(`\n  ✓ ${res.action} theme "${res.name}" in ${PROJECT_THEME_FILE}  (${res.count} theme${res.count === 1 ? '' : 's'})`);
  console.log('    use it anywhere:');
  console.log(`      atris deck from doc.md --html --theme ${res.name}`);
  console.log(`      atris site ./docs --theme ${res.name}`);
  console.log(`    tweak it later:  atris theme edit ${res.name}\n`);
  return 0;
}

async function run(argv) {
  const sub = argv[0];
  const rest = argv.slice(1);

  if (sub === 'create' || sub === 'new') {
    const { flags, pos } = parseFlags(rest);
    return createFlow({ name: pos[0], flags });
  }

  if (sub === 'edit') {
    const { flags, pos } = parseFlags(rest);
    const name = pos[0] || flags.name;
    if (!name) { console.error('  usage: atris theme edit <name>'); return 2; }
    const existing = loadProjectThemes()[name];
    if (!existing) { console.error(`  no project theme "${name}". make one with: atris theme create ${name}`); return 2; }
    // prefer the saved recipe; otherwise seed from the resolved colors/fonts
    const recipe = loadThemeRecipe(name);
    const defaults = recipe || { accent: existing.color.accent, accent2: existing.color.accent2, fonts: existing.fonts };
    defaults.name = name;
    return createFlow({ name, defaults, flags });
  }

  if (sub === 'init') {
    const { file, already } = writeStarterTheme();
    console.log(already
      ? `\n  already exists: ${file}\n  customize it with: atris theme edit brand\n`
      : `\n  ✓ brand theme scaffolded: ${file}\n    or build one by feel:  atris theme create\n`);
    return 0;
  }

  if (sub === 'show') {
    const name = rest[0];
    const t = mergedThemes(HTML_THEMES)[name];
    if (!t) { console.error(`  unknown theme "${name}"`); return 2; }
    console.log(JSON.stringify(t, null, 2));
    return 0;
  }

  // list (default)
  const project = loadProjectThemes();
  const all = mergedThemes(HTML_THEMES);
  console.log('\n  atris themes:\n');
  for (const name of Object.keys(all)) {
    const tag = project[name] ? 'project' : 'built-in';
    console.log(`  ${sw(all[name].color.accent)} ${name.padEnd(12)} accent ${all[name].color.accent}  bg ${all[name].color.bg}  (${tag})`);
  }
  console.log(`\n  make your own by feel:  atris theme create`);
  console.log(`  themes live in ${PROJECT_THEME_FILE}. Used by deck, html, and site.\n`);
  return 0;
}

module.exports = { run };
