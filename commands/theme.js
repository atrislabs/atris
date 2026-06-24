// atris theme — brand themes for the whole design system. Define your colors and
// fonts once in .atris/theme.json; every deck, HTML page, and site uses them.
//
//   atris theme init          scaffold .atris/theme.json
//   atris theme list          list built-in + project themes
//   atris theme show <name>   print a resolved theme

const { mergedThemes, writeStarterTheme, loadProjectThemes, PROJECT_THEME_FILE } = require('../lib/theme');
const { THEMES: HTML_THEMES } = require('../lib/html-render');

function run(argv) {
  const sub = argv[0];

  if (sub === 'init') {
    const { file, already } = writeStarterTheme();
    console.log(already
      ? `\n  already exists: ${file}\n`
      : `\n  ✓ brand theme scaffolded: ${file}\n    edit the colors, then build anything on-brand:\n    atris deck from doc.md --html --theme brand\n`);
    return 0;
  }

  if (sub === 'show') {
    const name = argv[1];
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
    console.log(`  ${name.padEnd(12)} accent ${all[name].color.accent}  bg ${all[name].color.bg}  (${tag})`);
  }
  console.log(`\n  define your own in ${PROJECT_THEME_FILE} (atris theme init). Used by deck, html, and site.\n`);
  return 0;
}

module.exports = { run };
