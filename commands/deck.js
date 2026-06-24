// atris deck — generate a premium, on-brand Google Slides deck from a plain
// content spec, using the Atris deck engine (lib/slides-deck.js). The pitch:
// describe the deck, get the design system for free. No Arial-on-white slop.
//
// Usage:
//   atris deck themes                         list design themes
//   atris deck build <spec.json> [--title T] [--theme terminal|paper] [--update ID]
//   atris deck sample [--theme paper]         print a starter spec to stdout
//
// A spec is JSON: { theme, brand:{name,accent}, slides:[ {type,...} ] }.
// Slide types: title, statement, columns, panel, chips, bignumber, close.

const fs = require('fs');
const https = require('https');
const os = require('os');
const { buildDeck, THEMES } = require('../lib/slides-deck');
const { parseMarkdownToSpec } = require('../lib/deck-from-md');
const { mergedThemes } = require('../lib/theme');

const BASE = 'api.atris.ai';
const PFX = '/api/integrations/google-slides';

function token() {
  try { return require(os.homedir() + '/.atris/credentials.json').token; }
  catch { return null; }
}
function api(method, path, body, tok) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({ host: BASE, path: PFX + path, method,
      headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) } },
      (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => {
        let j; try { j = JSON.parse(b); } catch { j = b; }
        if (res.statusCode >= 300) reject(new Error('HTTP ' + res.statusCode + ': ' + (typeof j === 'string' ? j : JSON.stringify(j)).slice(0, 600)));
        else resolve(j); }); });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}

const SAMPLE = {
  theme: 'terminal',
  brand: { name: 'Sentinel', accent: '.' },
  slides: [
    { type: 'title', headline: 'Read your incidents in the **dark.**',
      sub: "On-call shouldn't mean panic. Every alert ranked by blast radius, in one calm view.",
      panel: { header: { title: 'Active incidents', meta: 'updated 12s ago' },
        rows: [
          { title: 'Checkout latency spike', sub: 'api-gateway · us-east-1', value: '42%', valueSub: 'of traffic', sev: 0, active: true },
          { title: 'Stale read replica', sub: 'orders-db · eu-west-2', value: '8%', valueSub: 'of traffic', sev: 1 },
          { title: 'Elevated 4xx on search', sub: 'search-svc · global', value: '1.2%', valueSub: 'of traffic', sev: 2 },
        ], footer: { left: '3 active, 1 worth a page', right: 'View all' } } },
    { type: 'statement', text: "On-call shouldn't mean **panic.**",
      sub: 'So the console is calm by default. One screen, ranked by real impact.' },
    { type: 'columns', heading: 'What makes it calm', columns: [
      { h: 'Ranked by impact', b: 'Severity comes from real blast radius, so the top of the list is the thing to fix.' },
      { h: 'Quiet by default', b: 'One page-worthy signal per incident. The rest stays in the log until you ask.' },
      { h: 'Built for 3am', b: 'High contrast, keyboard-first, and readable before you are fully awake.' } ] },
    { type: 'bignumber', number: '11 min', label: 'median time to first action', sub: 'down from 47 minutes before Sentinel.' },
    { type: 'close', tagline: 'Read your incidents in the dark.',
      buttons: [{ label: 'Open the console', primary: true }, { label: 'Read the docs' }], footer: 'sentinel.sh · 2026' },
  ],
};

// shared: spec -> live deck. Returns the URL.
async function publishDeck(spec, { title, updateId, tok }) {
  const { requests } = buildDeck(spec, { themes: mergedThemes(THEMES) });
  let id, firstSlide;
  if (updateId) {
    id = updateId;
    const got = await api('GET', `/presentations/${id}`, null, tok);
    const slides = got.slides || (got.presentation && got.presentation.slides) || [];
    firstSlide = slides[0] && slides[0].objectId;
  } else {
    const pres = await api('POST', '/presentations', { title }, tok);
    id = pres.presentationId || pres.id || (pres.presentation && pres.presentation.presentationId);
    const slides = pres.slides || (pres.presentation && pres.presentation.slides) || [];
    firstSlide = slides[0] && slides[0].objectId;
  }
  const reqs = firstSlide ? [...requests, { deleteObject: { objectId: firstSlide } }] : requests;
  console.log(`  building ${spec.slides.length} slides (${spec.theme}) · ${reqs.length} ops...`);
  await api('POST', `/presentations/${id}/batch-update`, { requests: reqs }, tok);
  return `https://docs.google.com/presentation/d/${id}/edit`;
}

// beautiful HTML output (page or AppBlock JSON) from a content spec
function outputHtml(spec, argv, srcLabel) {
  const { renderHtml, renderBlock, THEMES: HTML_THEMES } = require('../lib/html-render');
  const themes = mergedThemes(HTML_THEMES);
  if (!themes[spec.theme]) spec.theme = 'atris';
  const title = flag(argv, '--title');
  if (hasFlag(argv, '--block')) {
    console.log(JSON.stringify(renderBlock(spec, { title, themes }), null, 2));
    return 0;
  }
  const html = renderHtml(spec, { title, themes });
  const out = flag(argv, '--out');
  if (out) { fs.writeFileSync(out, html); console.log(`\n  ✓ html written: ${out}${srcLabel ? ` (from ${srcLabel})` : ''}\n`); }
  else process.stdout.write(html + '\n');
  return 0;
}

async function run(argv) {
  const sub = argv[0];

  if (sub === 'from') {
    const docPath = argv.slice(1).find((a) => !a.startsWith('-'));
    if (!docPath) { console.error('  usage: atris deck from <doc.md> [--theme x] [--brand Name] [--build] [--title T]'); return 2; }
    let md;
    try { md = fs.readFileSync(docPath, 'utf8'); }
    catch (e) { console.error(`  cannot read doc: ${e.message}`); return 2; }
    const spec = parseMarkdownToSpec(md, { theme: flag(argv, '--theme'), brandName: flag(argv, '--brand') });
    if (hasFlag(argv, '--html') || hasFlag(argv, '--block')) return outputHtml(spec, argv, docPath);
    { const dt = mergedThemes(THEMES); if (!dt[spec.theme]) { console.error(`  unknown theme "${spec.theme}". try: ${Object.keys(dt).join(', ')}`); return 2; } }
    if (!hasFlag(argv, '--build')) {
      // default: print the spec so the PM can tweak before building
      console.log(JSON.stringify(spec, null, 2));
      return 0;
    }
    const tok = token();
    if (!tok) { console.error('  no credentials at ~/.atris/credentials.json — run `atris login` and connect Google Drive.'); return 1; }
    const title = flag(argv, '--title') || `${(spec.brand && spec.brand.name) || 'Atris'} deck`;
    const url = await publishDeck(spec, { title, updateId: flag(argv, '--update'), tok });
    console.log(`\n  ✓ deck from ${docPath} ready: ${url}\n`);
    return 0;
  }

  if (sub === 'themes') {
    console.log('\n  atris deck themes:\n');
    for (const [name, t] of Object.entries(THEMES)) {
      console.log(`  ${name.padEnd(10)} ${t.fonts.display} + ${t.fonts.body}  ·  accent ${t.color.accent}  bg ${t.color.bg}`);
    }
    console.log('\n  slide types: title, statement, columns, panel, chips, bignumber, close\n');
    return 0;
  }

  if (sub === 'sample') {
    const theme = flag(argv, '--theme') || 'terminal';
    console.log(JSON.stringify({ ...SAMPLE, theme }, null, 2));
    return 0;
  }

  if (sub === 'build') {
    const specPath = argv.slice(1).find((a) => !a.startsWith('-'));
    if (!specPath) { console.error('  usage: atris deck build <spec.json> [--title T] [--theme x] [--update ID]'); return 2; }
    let spec;
    try { spec = JSON.parse(fs.readFileSync(specPath, 'utf8')); }
    catch (e) { console.error(`  cannot read spec: ${e.message}`); return 2; }
    const themeOverride = flag(argv, '--theme'); if (themeOverride) spec.theme = themeOverride;
    if (hasFlag(argv, '--html') || hasFlag(argv, '--block')) return outputHtml(spec, argv, specPath);
    { const dt = mergedThemes(THEMES); if (!dt[spec.theme]) { console.error(`  unknown theme "${spec.theme}". try: ${Object.keys(dt).join(', ')}`); return 2; } }
    const title = flag(argv, '--title') || `${(spec.brand && spec.brand.name) || 'Atris'} deck`;

    const tok = token();
    if (!tok) { console.error('  no credentials at ~/.atris/credentials.json — run `atris login` and connect Google Drive.'); return 1; }

    const url = await publishDeck(spec, { title, updateId: flag(argv, '--update'), tok });
    console.log(`\n  ✓ deck ready: ${url}\n`);
    return 0;
  }

  console.log(`
  atris deck — premium Google Slides from a plain content spec or a markdown doc

    atris deck from doc.md [--build] [--title T]   turn a markdown doc into a deck
    atris deck from doc.md --html --out page.html  beautiful HTML page (theme: atris|terminal|paper)
    atris deck from doc.md --block                 emit the AppBlock JSON for a web app
    atris deck sample [--theme paper] > my.json    start from a sample spec
    atris deck build my.json [--title "Q3 review"] create the deck, print the URL
    atris deck build my.json --html --out p.html   render the spec as HTML instead of slides
    atris deck themes                              list design themes

  'from' maps headings to slides (## with bullets -> columns, "**X** label" -> a
  big number, Close -> a closing slide). Without --build it prints the spec to tweak.
  Design system is baked in: distinctive fonts, one accent, real data panels, and
  no AI tells (em dashes sanitized, sentence-case labels, no gradient text).
`);
  return 0;
}

function flag(argv, name) { const i = argv.indexOf(name); return i !== -1 ? argv[i + 1] : null; }
function hasFlag(argv, name) { return argv.includes(name); }

module.exports = { run, SAMPLE, publishDeck };
