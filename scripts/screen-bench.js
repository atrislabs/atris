#!/usr/bin/env node
// Scorecard for the page rules (lib/page-rules/) against a labelled bench folder:
// <dir>/pages/*.html and <dir>/labels.json (labels[page].tells[label] = { present, evidence, line }).
// It prints what was caught and what may be a false alarm. Always exits 0: a scorecard, not a gate.
//
//   node scripts/screen-bench.js [dir] [--json]

const fs = require('fs');
const os = require('os');
const path = require('path');
const { checkPage, PAGE_RULES } = require('../lib/page-rules');

const LABEL_RULE = {
  'arrow-in-button': 'page-button-arrow', 'dot-between-words': 'page-dot-separator', 'label-above-heading': 'page-label-above-heading',
  'pill-above-headline': 'page-label-above-heading', 'italic-word-in-headline': 'page-headline-accent', 'sparkle-icon': 'page-sparkle',
  'card-grid': 'page-card-grid', 'card-in-card': 'page-card-in-card', 'word-quiet': 'page-word-quiet', 'word-real': 'page-word-real',
  'numbered-sections': 'page-numbered-sections', 'looping-animation': 'page-looping-motion', 'blur-glow': 'page-glow',
  'banned-font': 'page-banned-font', 'colored-left-border': 'page-left-border', 'stat-without-source': 'page-unsourced-number',
  'two-word-sentence': 'page-two-word-sentence', 'scroll-fade': 'page-scroll-fade', 'dither-or-noise': 'page-noise',
  'subtitle-under-heading': 'page-subtitle', 'explanatory-text': 'page-explanatory', 'all-caps': 'page-all-caps',
  'gradient-text-or-purple-gradient': 'page-gradient-text', 'glass-effect': 'page-glass', 'placeholder-copy': 'page-placeholder',
  'emoji-as-icon': 'page-emoji-icon',
};

// The readers counted Fraunces as a banned font; the rule does not ban it.
const fraunceOnly = (label, tell) => label === 'banned-font' && /fraunces/i.test(tell.evidence || '') && !/instrument|playfair|\binter\b|roboto/i.test(tell.evidence || '');

function score(dir) {
  const labels = JSON.parse(fs.readFileSync(path.join(dir, 'labels.json'), 'utf8')).labels || {};
  const perRule = Object.fromEntries(PAGE_RULES.map((r) => [r.id, { caught: 0, labelled: 0, missed: [] }]));
  const alarms = [];
  let withTell = 0, caught = 0;
  const pages = [];
  for (const [name, entry] of Object.entries(labels)) {
    const file = path.join(dir, 'pages', name);
    if (!fs.existsSync(file)) continue;
    const res = checkPage(fs.readFileSync(file, 'utf8'), name);
    const fired = new Set(res.findings.map((f) => f.rule));
    const present = new Set(), absent = new Set();
    for (const [label, tell] of Object.entries(entry.tells || {})) {
      const rule = LABEL_RULE[label];
      if (!rule || tell.present == null || fraunceOnly(label, tell)) continue;
      if (tell.present) {
        present.add(rule);
        perRule[rule].labelled++;
        if (fired.has(rule)) perRule[rule].caught++;
        else perRule[rule].missed.push(`${name}:${tell.line || '?'}`);
      } else absent.add(rule);
    }
    for (const f of res.findings) if (absent.has(f.rule) && !present.has(f.rule)) alarms.push({ page: name, line: f.line, rule: f.rule, text: f.text });
    // a page counts as caught only when a rule for one of its labelled tells fired
    if (present.size) { withTell++; if ([...present].some((r) => fired.has(r))) caught++; }
    pages.push({ page: name, findings: res.findings.length, rules: [...fired] });
  }
  return { dir, pages: { caught, withTell }, rules: perRule, alarms, perPage: pages };
}

function main(argv) {
  const json = argv.includes('--json');
  const dir = argv.find((a) => !a.startsWith('--')) || path.join(os.homedir(), '.atris', 'screen-bench-dev');
  let out;
  try { out = score(dir); } catch (err) {
    console.log(json ? JSON.stringify({ ok: false, error: err.message }) : `  could not read the bench at ${dir}: ${err.message}`);
    return 0;
  }
  if (json) { console.log(JSON.stringify(out, null, 2)); return 0; }
  console.log(`\n  pages caught: ${out.pages.caught} of ${out.pages.withTell} pages with a labelled tell\n`);
  const w = Math.max(...PAGE_RULES.map((r) => r.id.length));
  console.log(`  ${'rule'.padEnd(w)}  ${'caught'.padEnd(10)}missed on`);
  for (const r of PAGE_RULES) {
    const s = out.rules[r.id];
    const ratio = s.labelled ? `${s.caught} of ${s.labelled}` : 'no labels';
    console.log(`  ${r.id.padEnd(w)}  ${ratio.padEnd(10)}${s.missed.length ? s.missed.join(', ') : ''}`);
  }
  console.log(`\n  possible false alarms (the label says no): ${out.alarms.length}`);
  for (const a of out.alarms) console.log(`  ${`${a.page}:${a.line}`.padEnd(60)} ${a.rule.padEnd(w)} "${a.text}"`);
  console.log('');
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { score, LABEL_RULE };
