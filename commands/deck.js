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

async function run(argv) {
  const sub = argv[0];

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
    if (!THEMES[spec.theme]) { console.error(`  unknown theme "${spec.theme}". try: ${Object.keys(THEMES).join(', ')}`); return 2; }
    const title = flag(argv, '--title') || `${(spec.brand && spec.brand.name) || 'Atris'} deck`;

    const tok = token();
    if (!tok) { console.error('  no credentials at ~/.atris/credentials.json — run `atris login` and connect Google Drive.'); return 1; }

    const { requests } = buildDeck(spec);

    let id, firstSlide;
    const updateId = flag(argv, '--update');
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

    const url = `https://docs.google.com/presentation/d/${id}/edit`;
    console.log(`\n  ✓ deck ready: ${url}\n`);
    return 0;
  }

  console.log(`
  atris deck — premium Google Slides from a plain content spec

    atris deck sample [--theme paper] > my.json   start from a sample spec
    atris deck build my.json [--title "Q3 review"] create the deck, print the URL
    atris deck build my.json --update <id>         rebuild into an existing deck
    atris deck themes                              list design themes

  Design system is baked in: distinctive fonts, one accent, real data panels,
  and no AI tells (em dashes sanitized, sentence-case labels, no gradient text).
`);
  return 0;
}

function flag(argv, name) { const i = argv.indexOf(name); return i !== -1 ? argv[i + 1] : null; }

module.exports = { run, SAMPLE };
