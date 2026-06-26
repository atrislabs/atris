// atris card — one line of text -> a beautiful, on-brand image (your theme).
//
//   atris card "Ship faster" --kind statement --theme brand --size og
//   atris card "It just works" --kind quote --by "a happy user"
//   atris card --kind stat --number "10x" --label "faster reviews"
//
// Writes an .html (always) and a .png (when headless Chrome is available).

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync, spawnSync } = require('child_process');
const { buildCard, SIZES, KINDS } = require('../lib/card');

function parseFlags(argv) {
  const flags = {}; const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--html-only') { flags.htmlOnly = true; continue; }
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next != null && !next.startsWith('--')) { flags[key] = next; i++; } else flags[key] = true;
      continue;
    }
    pos.push(a);
  }
  return { flags, pos };
}

// find an installed Chrome/Chromium without adding a dependency
function findChrome() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const macApps = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ];
  for (const p of macApps) if (fs.existsSync(p)) return p;
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'chrome']) {
    const r = spawnSync('command', ['-v', name], { shell: true, encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  }
  return null;
}

function renderPng(chrome, html, width, height, outPng) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-card-'));
  const htmlFile = path.join(tmp, 'card.html');
  fs.writeFileSync(htmlFile, html);
  const args = [
    '--headless=new', '--disable-gpu', '--hide-scrollbars',
    '--force-device-scale-factor=2',
    `--window-size=${width},${height}`,
    '--virtual-time-budget=4000',
    `--screenshot=${outPng}`,
    `file://${htmlFile}`,
  ];
  execFileSync(chrome, args, { stdio: 'ignore', timeout: 60000 });
  return fs.existsSync(outPng);
}

function run(argv) {
  const { flags, pos } = parseFlags(argv);

  if (pos[0] === 'help' || flags.help) {
    console.log(`\n  atris card — one line of text into an on-brand image\n
  atris card "Your headline" [--kind statement|quote|stat] [--theme <name>] [--size og|wide|square|story]
  flags: --sub --kicker --by --number --label --brand --version --out <file.png> --html-only\n
  examples:
    atris card "Design that builds itself" --kicker "Atris v3.23.0" --theme brand
    atris card "It just works." --kind quote --by "a founder" --size square
    atris card --kind stat --number "1260" --label "tests, all green"\n`);
    return 0;
  }

  const text = pos.join(' ').trim();
  const kind = flags.kind || 'statement';
  if (!KINDS.includes(kind)) { console.error(`  unknown kind "${kind}". try: ${KINDS.join(', ')}`); return 2; }
  if (flags.size && !SIZES[flags.size]) { console.error(`  unknown size "${flags.size}". try: ${Object.keys(SIZES).join(', ')}`); return 2; }
  if (kind === 'stat' && !flags.number && !text) { console.error('  stat cards need --number (e.g. --number "10x")'); return 2; }
  if (kind !== 'stat' && !text) { console.error('  give the card some text: atris card "Your headline"'); return 2; }

  const spec = {
    kind, text, headline: text,
    theme: flags.theme, size: flags.size,
    sub: flags.sub, kicker: flags.kicker, by: flags.by,
    number: flags.number, label: flags.label,
    brand: flags.brand, version: flags.version,
  };

  let card;
  try { card = buildCard(spec); }
  catch (e) { console.error(`  could not build card: ${e.message}`); return 1; }

  const base = (flags.out ? String(flags.out).replace(/\.png$/i, '') : `card-${kind}-${card.theme}-${card.size}`);
  const outPng = path.resolve(`${base}.png`);
  const outHtml = path.resolve(`${base}.html`);
  fs.writeFileSync(outHtml, card.html);

  if (flags.htmlOnly) {
    console.log(`\n  ✓ ${card.kind} card (${card.width}x${card.height}, theme ${card.theme})\n    html: ${outHtml}\n    open it, or render a png with Chrome installed.\n`);
    return 0;
  }

  const chrome = findChrome();
  if (!chrome) {
    console.log(`\n  ✓ wrote html: ${outHtml}\n    no Chrome found for png. open the html, or set CHROME_PATH and re-run.\n`);
    return 0;
  }
  try {
    renderPng(chrome, card.html, card.width, card.height, outPng);
    console.log(`\n  ✓ ${card.kind} card, ${card.width}x${card.height}, theme ${card.theme}\n    ${outPng}\n`);
    return 0;
  } catch (e) {
    console.log(`\n  ! png render failed (${e.message.split('\n')[0]})\n    html is ready: ${outHtml}\n`);
    return 0;
  }
}

module.exports = { run };
