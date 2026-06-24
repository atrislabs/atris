// atris deck — generate a premium, on-brand Google Slides deck from a plain
// content spec, using the Atris deck engine (lib/slides-deck.js). The pitch:
// describe the deck, get the design system for free. No Arial-on-white slop.
//
// Usage:
//   atris deck themes                         list design themes
//   atris deck build <spec.json> [--title T] [--theme terminal|paper|ink|noir] [--review]
//   atris deck lint <spec.json>               pre-build layout warnings
//   atris deck review <id|url> [--spec path] [--confirm NOTE] [--json]
//   atris deck sample [--theme paper]         print a starter spec
//
// A spec is JSON: { theme, brand:{name,accent}, slides:[ {type,...} ] }.
// Slide types: title, statement, columns, panel, chips, bignumber, close,
//   timeline, versus, metricgrid, receipt, stack, quote, hero.

const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');
const { buildDeck, THEMES } = require('../lib/slides-deck');
const {
  lintSpec,
  reviewDeck,
  confirmReview,
  extractPresentationId,
  DEFAULT_OUT_ROOT,
} = require('../lib/deck-review');
const { validateSpec, checkSpec, hasErrors } = require('../lib/deck-schema');
const { recordBuild, historyFor } = require('../lib/deck-history');

const BASE = 'api.atris.ai';
const PFX = '/api/integrations/google-slides';

function token() {
  try { return require(path.join(os.homedir(), '.atris/credentials.json')).token; }
  catch { return null; }
}

function api(method, apiPath, body, tok) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      host: BASE,
      path: PFX + apiPath,
      method,
      headers: {
        Authorization: `Bearer ${tok}`,
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => {
        let j;
        try { j = JSON.parse(b); } catch { j = b; }
        if (res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode}: ${(typeof j === 'string' ? j : JSON.stringify(j)).slice(0, 600)}`));
        } else {
          resolve(j);
        }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const THEME_HINTS = {
  terminal: 'warm dark · investor / product wedge',
  paper: 'warm light · editorial default',
  ink: 'stark light · magazine / press',
  noir: 'cool dark · podcast / interview',
};

const SAMPLE = {
  theme: 'terminal',
  brand: { name: 'Sentinel', accent: '.' },
  slides: [
    {
      type: 'title',
      headline: 'Read your incidents in the **dark.**',
      sub: "On-call shouldn't mean panic. Every alert ranked by blast radius, in one calm view.",
      panel: {
        header: { title: 'Active incidents', meta: 'updated 12s ago' },
        rows: [
          { title: 'Checkout latency spike', sub: 'api-gateway · us-east-1', value: '42%', valueSub: 'of traffic', sev: 0, active: true },
          { title: 'Stale read replica', sub: 'orders-db · eu-west-2', value: '8%', valueSub: 'of traffic', sev: 1 },
          { title: 'Elevated 4xx on search', sub: 'search-svc · global', value: '1.2%', valueSub: 'of traffic', sev: 2 },
        ],
        footer: { left: '3 active, 1 worth a page', right: 'View all' },
      },
    },
    { type: 'statement', text: "On-call shouldn't mean **panic.**", sub: 'So the console is calm by default. One screen, ranked by real impact.' },
    {
      type: 'columns',
      heading: 'What makes it calm',
      columns: [
        { h: 'Ranked by impact', b: 'Severity comes from real blast radius, so the top of the list is the thing to fix.' },
        { h: 'Quiet by default', b: 'One page-worthy signal per incident. The rest stays in the log until you ask.' },
        { h: 'Built for 3am', b: 'High contrast, keyboard-first, and readable before you are fully awake.' },
      ],
    },
    { type: 'bignumber', number: '11 min', label: 'median time to first action', sub: 'down from 47 minutes before Sentinel.' },
    {
      type: 'close',
      tagline: 'Read your incidents in the dark.',
      buttons: [{ label: 'Open the console', primary: true }, { label: 'Read the docs' }],
      footer: 'sentinel.sh · 2026',
    },
  ],
};

function flag(argv, name) {
  const i = argv.indexOf(name);
  return i !== -1 ? argv[i + 1] : null;
}

function hasFlag(argv, name) {
  return argv.includes(name);
}

function readSpec(specPath) {
  return JSON.parse(fs.readFileSync(specPath, 'utf8'));
}

function printLint(findings) {
  if (!findings.length) {
    console.log('\n  ✓ spec lint clean\n');
    return;
  }
  console.log('');
  for (const f of findings) {
    const icon = f.severity === 'error' ? '✗' : f.severity === 'warn' ? '⚠' : '·';
    console.log(`  ${icon} slide ${f.slide}  ${f.rule.padEnd(22)} ${f.message}`);
  }
  console.log('');
}

async function runReviewFlow({ presentationId, spec, specPath, json }) {
  const tok = token();
  if (!tok) {
    console.error('  no credentials at ~/.atris/credentials.json — run `atris login` and connect Google Drive.');
    return 1;
  }
  const { packet, manifestPath, outDir } = await reviewDeck({
    presentationId,
    spec,
    specPath,
    api,
    token: tok,
  });
  if (json) {
    console.log(JSON.stringify({ ...packet, manifestPath, outDir }, null, 2));
  } else {
    console.log(`\n  review packet: ${manifestPath}`);
    console.log(`  thumbnails:    ${outDir}`);
    console.log(`  status:          ${packet.status}`);
    console.log(`  slides:          ${packet.slides.length}`);
    if (packet.specLint.length) {
      printLint(packet.specLint);
    } else {
      console.log('  spec lint:       clean');
    }
    console.log('  next: open PNGs, fix spec if needed, then:');
    console.log(`        atris deck review ${packet.presentationId} --confirm "looks good"\n`);
  }
  return 0;
}

// Pure: given the engine's build requests and what the API reports, produce the
// final batch-update request list.
//   - update: delete every existing slide first, then add the fresh ones. The
//     engine reuses fixed objectIds (deck_slide_N), so a prior build's slides
//     must be removed before recreating them or the API rejects duplicate IDs.
//   - create: append a delete of the blank default slide a new deck ships with.
function planBatch({ requests, updateId = null, existingSlides = [], newFirstSlideId = null }) {
  if (updateId) {
    const deletions = (existingSlides || [])
      .filter((s) => s && s.objectId)
      .map((s) => ({ deleteObject: { objectId: s.objectId } }));
    return [...deletions, ...requests];
  }
  return newFirstSlideId ? [...requests, { deleteObject: { objectId: newFirstSlideId } }] : requests;
}

// Publish a deck via the Slides API (create or in-place update). api/token are
// injected so this is unit-testable with a mock transport.
async function publishDeck({ spec, title, updateId, api: apiFn, token: tok }) {
  const { requests } = buildDeck(spec);
  let id;
  let batch;
  if (updateId) {
    id = updateId;
    const got = await apiFn('GET', `/presentations/${id}`, null, tok);
    const existing = got.slides || (got.presentation && got.presentation.slides) || [];
    batch = planBatch({ requests, updateId, existingSlides: existing });
  } else {
    const pres = await apiFn('POST', '/presentations', { title }, tok);
    id = pres.presentationId || pres.id || (pres.presentation && pres.presentation.presentationId);
    const slides = pres.slides || (pres.presentation && pres.presentation.slides) || [];
    batch = planBatch({ requests, newFirstSlideId: slides[0] && slides[0].objectId });
  }
  await apiFn('POST', `/presentations/${id}/batch-update`, { requests: batch }, tok);
  return { id, url: `https://docs.google.com/presentation/d/${id}/edit`, ops: batch.length };
}

async function run(argv) {
  const sub = argv[0];

  if (sub === 'themes') {
    console.log('\n  atris deck themes:\n');
    for (const [name, t] of Object.entries(THEMES)) {
      const hint = THEME_HINTS[name] || '';
      console.log(`  ${name.padEnd(10)} ${hint}`);
      console.log(`             ${t.fonts.display} + ${t.fonts.body}  ·  accent ${t.color.accent}  bg ${t.color.bg}`);
    }
    console.log('\n  pick one: spec.json "theme" field  OR  atris deck build spec.json --theme noir');
    console.log('\n  slide types: title, statement, columns, panel, chips, bignumber, close,');
    console.log('               timeline, versus, metricgrid, receipt, stack, quote, hero,');
    console.log('               interstitial, lede, prose, split, bullets  (narrative / box-free)\n');
    return 0;
  }

  if (sub === 'sample') {
    const theme = flag(argv, '--theme') || 'terminal';
    console.log(JSON.stringify({ ...SAMPLE, theme }, null, 2));
    return 0;
  }

  if (sub === 'history') {
    const query = argv.slice(1).find((a) => !a.startsWith('-'));
    const entries = historyFor(query);
    if (hasFlag(argv, '--json')) {
      console.log(JSON.stringify(entries, null, 2));
      return 0;
    }
    if (!entries.length) {
      console.log(`\n  no deck builds recorded${query ? ` for "${query}"` : ''} yet\n`);
      return 0;
    }
    console.log('');
    for (const e of entries) {
      const when = (e.at || '').replace('T', ' ').slice(0, 16);
      console.log(`  ${when}  ${String(e.mode).padEnd(6)} ${String(e.slideCount).padStart(2)}sl ${String(e.theme || '?').padEnd(8)} ${e.specHash}`);
      console.log(`                    ${e.specPath || '(inline)'}  ->  ${e.url || e.presentationId}`);
    }
    console.log('');
    return 0;
  }

  if (sub === 'lint') {
    const specPath = argv.slice(1).find((a) => !a.startsWith('-'));
    if (!specPath) {
      console.error('  usage: atris deck lint <spec.json>');
      return 2;
    }
    let spec;
    try { spec = readSpec(specPath); }
    catch (e) { console.error(`  cannot read spec: ${e.message}`); return 2; }
    const findings = checkSpec(spec, lintSpec);
    if (hasFlag(argv, '--json')) {
      console.log(JSON.stringify({ ok: !hasErrors(findings), findings }, null, 2));
    } else {
      printLint(findings);
    }
    return hasErrors(findings) ? 1 : 0;
  }

  if (sub === 'review') {
    const idArg = argv.slice(1).find((a) => !a.startsWith('-'));
    if (!idArg) {
      console.error('  usage: atris deck review <presentation-id|url> [--spec spec.json] [--confirm NOTE] [--json]');
      return 2;
    }
    const confirmNote = flag(argv, '--confirm');
    if (confirmNote) {
      const { manifestPath, packet, alreadyConfirmed } = confirmReview(extractPresentationId(idArg), confirmNote);
      if (hasFlag(argv, '--json')) {
        console.log(JSON.stringify({ manifestPath, packet, alreadyConfirmed }, null, 2));
      } else {
        console.log(`\n  ✓ review confirmed: ${manifestPath}`);
        console.log(`  deck: ${packet.url}\n`);
      }
      return 0;
    }
    const specPath = flag(argv, '--spec');
    let spec = null;
    if (specPath) {
      try { spec = readSpec(specPath); }
      catch (e) { console.error(`  cannot read spec: ${e.message}`); return 2; }
    }
    return runReviewFlow({
      presentationId: idArg,
      spec,
      specPath,
      json: hasFlag(argv, '--json'),
    });
  }

  if (sub === 'build') {
    const specPath = argv.slice(1).find((a) => !a.startsWith('-'));
    if (!specPath) {
      console.error('  usage: atris deck build <spec.json> [--title T] [--theme x] [--review]');
      return 2;
    }
    let spec;
    try { spec = readSpec(specPath); }
    catch (e) { console.error(`  cannot read spec: ${e.message}`); return 2; }
    const themeOverride = flag(argv, '--theme');
    if (themeOverride) spec.theme = themeOverride;
    if (!THEMES[spec.theme]) {
      console.error(`  unknown theme "${spec.theme}". try: ${Object.keys(THEMES).join(', ')}`);
      return 2;
    }
    // Hard schema gate: fail a malformed spec locally with a slide index,
    // before spending a network round trip on a doomed batch-update.
    const schemaFindings = validateSpec(spec);
    if (hasErrors(schemaFindings)) {
      printLint(schemaFindings);
      console.error('\n  ✗ spec invalid — fix the errors above before building\n');
      return 2;
    }
    const title = flag(argv, '--title') || `${(spec.brand && spec.brand.name) || 'Atris'} deck`;
    const doReview = hasFlag(argv, '--review');
    const updateId = flag(argv, '--update');
    if (doReview) {
      const findings = lintSpec(spec);
      printLint(findings);
      if (findings.some((f) => f.severity === 'error')) {
        console.error('\n  ✗ lint failed — fix spec before building\n');
        return 1;
      }
    }

    const tok = token();
    if (!tok) {
      console.error('  no credentials at ~/.atris/credentials.json — run `atris login` and connect Google Drive.');
      return 1;
    }

    console.log(`  ${updateId ? 'updating' : 'building'} ${spec.slides.length} slides (${spec.theme})...`);
    const { id, url, ops } = await publishDeck({ spec, title, updateId, api, token: tok });
    // Ledger the build; never let a history write failure break a build.
    try { recordBuild({ spec, specPath, presentationId: id, url, mode: updateId ? 'update' : 'create' }); } catch { /* ignore */ }
    console.log(`\n  ✓ deck ${updateId ? 'updated' : 'ready'}: ${url}  (${ops} ops)\n`);

    if (doReview) {
      return runReviewFlow({ presentationId: id, spec, specPath, json: hasFlag(argv, '--json') });
    }
    return 0;
  }

  console.log(`
  atris deck — premium Google Slides from a plain content spec

    atris deck sample [--theme paper] > my.json
    atris deck lint my.json
    atris deck build my.json [--title "Q3 review"] [--update ID] [--review]
    atris deck review <id|url> [--spec my.json]
    atris deck review <id> --confirm "looks good"
    atris deck history [my.json]            builds recorded for a spec
    atris deck themes

    --update ID replaces every slide in an existing deck in place, so the
    presentation URL and id stay stable across rebuilds.

  Review loop:
    build --review -> downloads slide PNGs to ~/.atris/deck-review/<id>/
    agent inspects thumbnails -> fix spec/engine -> rebuild
    review --confirm -> marks deck ready

  Design system is baked in: distinctive fonts, one accent, real data panels,
  and no AI tells (em dashes sanitized, sentence-case labels, no gradient text).
`);
  return 0;
}

module.exports = {
  run,
  SAMPLE,
  api,
  token,
  lintSpec,
  validateSpec,
  checkSpec,
  planBatch,
  publishDeck,
  DEFAULT_OUT_ROOT,
};
