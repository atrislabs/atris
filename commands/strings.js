// atris strings — a content design system built from live codebase content (no LLM).
//
// The missing pillar next to `atris slop`: slop catches HOW copy is written (tells,
// hype, em-dashes); strings governs WHAT words you ship. It scans the repo for
// user-facing strings, builds a terminology registry in .atris/strings.json, flags
// the same string written three different ways (the "unnecessary variant" tell), and
// enforces preferred terms at the commit/PR gate so you rename "live" -> "active"
// once and it holds everywhere.
//
// Zero external deps (Node built-ins only) — repo contract. Deterministic: a finding
// is a fact (file:line + term), not a taste opinion, so it drops into CI + the gate.
//
// Usage:
//   atris strings scan [path]        # extract UI strings -> .atris/strings.json
//   atris strings variants           # the same string written N different ways
//   atris strings term --ban live --prefer active --why "..."   # codify a rule
//   atris strings check --staged     # gate: banned terms in changed lines (exit 1)
//   atris strings list               # dump the registry
//
// Exit code: 0 = clean, 1 = violation/variants found, 2 = bad usage.

const fs = require('fs');
const path = require('path');
const { gitChangedLines } = require('./slop'); // reuse the diff parser — DRY

const CODE_EXTS = new Set(['.tsx', '.jsx', '.ts', '.js', '.mjs', '.vue', '.svelte', '.astro', '.html']);
const TEXT_EXTS = new Set([...CODE_EXTS, '.md', '.mdx', '.txt']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.astro', 'coverage', '.cache', 'out', 'vendor']);

const REGISTRY_FILE = path.join('.atris', 'strings.json');
const MAX_LOCATIONS = 12; // cap stored locations per string so the registry stays readable

function walk(target, out, exts) {
  let stat;
  try { stat = fs.statSync(target); } catch { return out; }
  if (stat.isFile()) {
    if (exts.has(path.extname(target))) out.push(target);
    return out;
  }
  if (stat.isDirectory()) {
    if (SKIP_DIRS.has(path.basename(target))) return out;
    for (const name of fs.readdirSync(target)) {
      if (name.startsWith('.') && name !== '.') continue;
      walk(path.join(target, name), out, exts);
    }
  }
  return out;
}

// Is this captured literal a user-facing string, or just code/classes/identifiers?
// High precision on purpose: a noisy registry gets ignored. minWords lets JSX text
// nodes (>Settings<) keep single-word labels while quoted literals require a phrase.
function isUserFacing(s, minWords) {
  if (s.length < 2 || s.length > 200) return false;
  if (!/[A-Za-z]/.test(s)) return false;
  if (/[<>{}=]|\$\{|=>|&&|\|\||::|\/\/|\/\*|\*\//.test(s)) return false; // code
  if (/^https?:/i.test(s) || /\bwww\.[a-z]/i.test(s)) return false;       // urls
  if (/^[./~#@\\]/.test(s)) return false;                                  // path/anchor/hex/handle
  if (/^#[0-9a-fA-F]{3,8}$/.test(s)) return false;                         // hex color
  if (/^[A-Z0-9_]{2,}$/.test(s)) return false;                             // CONSTANT_CASE
  const words = s.split(/\s+/);
  // className / token-list reject: multi-token where most tokens look like classes
  if (words.length > 1
    && words.every((w) => /^[\w:[\]\-./%@]+$/.test(w))
    && words.filter((w) => w.includes('-')).length >= Math.ceil(words.length / 2)) return false;
  if (words.length === 1) {
    if (minWords > 1) return false;                 // quoted single tokens are usually identifiers
    return /^[A-Z][a-zA-Z]{2,}$/.test(s);           // a real Label word, e.g. "Settings"
  }
  const prose = (s.match(/[A-Za-z ]/g) || []).length;
  return prose / s.length >= 0.55;                  // reads like a sentence, not a payload
}

// Extract candidate user-facing strings from one file's text.
function extractStrings(text) {
  const out = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const push = (raw, minWords) => { const s = raw.trim(); if (isUserFacing(s, minWords)) out.push({ text: s, line: i + 1 }); };
    let m;
    const jsx = />([^<>{}\n]{2,})</g; while ((m = jsx.exec(line))) push(m[1], 1);          // JSX/HTML text node
    const dq = /"([^"\\\n]{2,}?)"/g; while ((m = dq.exec(line))) push(m[1], 2);            // "double"
    const sq = /'([^'\\\n]{2,}?)'/g; while ((m = sq.exec(line))) push(m[1], 2);            // 'single'
    const tq = /`([^`$\\\n]{2,}?)`/g; while ((m = tq.exec(line))) push(m[1], 2);           // `template` (no ${})
  }
  return out;
}

// Canonical form for variant detection: same meaning, different surface (case / punct / spacing).
function normalize(s) {
  return s.toLowerCase()
    .replace(/…/g, '').replace(/\.\.\.$/, '')
    .replace(/\s+/g, ' ')
    .replace(/[.!?,;:]+$/, '')
    .trim();
}

function loadRegistry(root = process.cwd()) {
  try { return JSON.parse(fs.readFileSync(path.join(root, REGISTRY_FILE), 'utf8')); }
  catch { return { version: 1, scannedAt: null, root: null, strings: [], terms: [] }; }
}

function saveRegistry(reg, root = process.cwd()) {
  const file = path.join(root, REGISTRY_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(reg, null, 2) + '\n');
  return file;
}

// Group strings by normalized form; a cluster with >1 distinct surface form is an inconsistency.
function variantClusters(strings) {
  const byNorm = new Map();
  for (const s of strings) {
    if (!byNorm.has(s.norm)) byNorm.set(s.norm, []);
    byNorm.get(s.norm).push(s);
  }
  const clusters = [];
  for (const [norm, group] of byNorm) {
    const surfaces = [...new Set(group.map((g) => g.text))];
    if (surfaces.length > 1) {
      clusters.push({ norm, surfaces, count: group.reduce((n, g) => n + g.count, 0) });
    }
  }
  return clusters.sort((a, b) => b.count - a.count);
}

function scan(argv) {
  const json = argv.includes('--json');
  const target = argv.find((a) => !a.startsWith('-')) || '.';
  const files = walk(path.resolve(target), [], CODE_EXTS);

  const byText = new Map(); // text -> { text, norm, count, locations[] }
  for (const file of files) {
    let text; try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const rel = path.relative(process.cwd(), file);
    for (const hit of extractStrings(text)) {
      let entry = byText.get(hit.text);
      if (!entry) { entry = { text: hit.text, norm: normalize(hit.text), count: 0, locations: [] }; byText.set(hit.text, entry); }
      entry.count++;
      if (entry.locations.length < MAX_LOCATIONS) entry.locations.push(`${rel}:${hit.line}`);
    }
  }

  const reg = loadRegistry();
  reg.scannedAt = new Date().toISOString();
  reg.root = path.relative(process.cwd(), path.resolve(target)) || '.';
  reg.strings = [...byText.values()].sort((a, b) => b.count - a.count);
  const file = saveRegistry(reg);
  const clusters = variantClusters(reg.strings);

  if (json) {
    console.log(JSON.stringify({
      ok: true, scanned: files.length, strings: reg.strings.length,
      occurrences: reg.strings.reduce((n, s) => n + s.count, 0),
      variantClusters: clusters.length, registry: path.relative(process.cwd(), file),
    }, null, 2));
    return 0;
  }
  console.log(`\n  scanned ${files.length} file${files.length === 1 ? '' : 's'} -> ${reg.strings.length} unique string${reg.strings.length === 1 ? '' : 's'}`);
  console.log(`  registry: ${path.relative(process.cwd(), file)}`);
  if (clusters.length) console.log(`\n  ⚠ ${clusters.length} variant cluster${clusters.length === 1 ? '' : 's'} (same string, different casing/punctuation) — run: atris strings variants`);
  else console.log(`\n  ✓ no inconsistent variants`);
  console.log('');
  return 0;
}

function variants(argv) {
  const json = argv.includes('--json');
  const reg = loadRegistry();
  if (!reg.strings.length) { console.error('  no registry yet — run: atris strings scan'); return 2; }
  const clusters = variantClusters(reg.strings);
  if (json) { console.log(JSON.stringify({ ok: clusters.length === 0, clusters }, null, 2)); return clusters.length ? 1 : 0; }
  if (!clusters.length) { console.log(`\n  ✓ clean — every string is written one way\n`); return 0; }
  console.log(`\n  ${clusters.length} variant cluster${clusters.length === 1 ? '' : 's'} — same string, inconsistent surface form:\n`);
  for (const c of clusters) {
    console.log(`  ⚠ ${c.surfaces.map((s) => JSON.stringify(s)).join('  vs  ')}   (${c.count}×)`);
  }
  console.log(`\n  pick one per cluster, then: atris strings term --ban "<wrong>" --prefer "<right>"\n`);
  return 1;
}

function term(argv) {
  const get = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : null; };
  const ban = get('--ban');
  const prefer = get('--prefer');
  const why = get('--why') || '';
  if (argv.includes('--list') || (!ban && !argv.includes('--remove'))) {
    const reg = loadRegistry();
    if (!reg.terms.length) { console.log('\n  no terms yet — add one: atris strings term --ban "live" --prefer "active"\n'); return 0; }
    console.log('\n  preferred terms (enforced by: atris strings check):\n');
    for (const t of reg.terms) console.log(`  ✗ "${t.ban}" → "${t.prefer}"${t.why ? `   (${t.why})` : ''}`);
    console.log('');
    return 0;
  }
  const reg = loadRegistry();
  if (argv.includes('--remove')) {
    const before = reg.terms.length;
    reg.terms = reg.terms.filter((t) => t.ban.toLowerCase() !== String(get('--remove') || ban || '').toLowerCase());
    saveRegistry(reg);
    console.log(`  ${before === reg.terms.length ? 'no match' : 'removed'}: "${get('--remove') || ban}"`);
    return 0;
  }
  if (!ban || !prefer) { console.error('  usage: atris strings term --ban <word> --prefer <word> [--why "..."]'); return 2; }
  reg.terms = reg.terms.filter((t) => t.ban.toLowerCase() !== ban.toLowerCase());
  reg.terms.push({ ban, prefer, why });
  const file = saveRegistry(reg);
  console.log(`  ✓ "${ban}" → "${prefer}" added to ${path.relative(process.cwd(), file)}`);
  console.log(`    enforce it: atris strings check --staged`);
  return 0;
}

function check(argv) {
  const json = argv.includes('--json');
  const quiet = argv.includes('--quiet');
  const staged = argv.includes('--staged');
  const diffMode = staged || argv.includes('--diff');
  const reg = loadRegistry();
  if (!reg.terms.length) {
    if (json) { console.log(JSON.stringify({ ok: true, terms: 0, findings: [] }, null, 2)); }
    else if (!quiet) console.log('\n  no terms to enforce — add one: atris strings term --ban "live" --prefer "active"\n');
    return 0;
  }

  let files, changed = null;
  if (diffMode) {
    changed = gitChangedLines(staged);
    files = [...changed.keys()].filter((f) => TEXT_EXTS.has(path.extname(f)) && fs.existsSync(f));
  } else {
    const target = argv.find((a) => !a.startsWith('-')) || '.';
    files = walk(path.resolve(target), [], TEXT_EXTS);
  }
  const regAbs = path.resolve(process.cwd(), REGISTRY_FILE);

  const matchers = reg.terms.map((t) => ({ ...t, re: new RegExp(`\\b${t.ban.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i') }));
  const findings = [];
  for (const file of files) {
    if (path.resolve(file) === regAbs) continue; // never flag the registry itself
    let text; try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (diffMode && changed && !(changed.get(path.resolve(file)) && changed.get(path.resolve(file)).has(i + 1))) continue;
      for (const t of matchers) {
        if (t.re.test(lines[i])) findings.push({ file: path.relative(process.cwd(), file), line: i + 1, ban: t.ban, prefer: t.prefer, why: t.why });
      }
    }
  }

  if (json) { console.log(JSON.stringify({ ok: findings.length === 0, scanned: files.length, terms: reg.terms.length, findings }, null, 2)); return findings.length ? 1 : 0; }
  if (!findings.length) { if (!quiet) console.log(`\n  ✓ clean — no banned terms in ${files.length} file${files.length === 1 ? '' : 's'}\n`); else console.log('  ✓ clean · exit 0'); return 0; }
  if (!quiet) {
    console.log('');
    const w = Math.max(...findings.map((f) => `${f.file}:${f.line}`.length));
    for (const f of findings) console.log(`  ✗ ${`${f.file}:${f.line}`.padEnd(w)}  "${f.ban}" → "${f.prefer}"${f.why ? `   ${f.why}` : ''}`);
  }
  console.log(`\n  ${findings.length} banned-term use${findings.length === 1 ? '' : 's'} · exit 1\n`);
  return 1;
}

function list(argv) {
  const json = argv.includes('--json');
  const reg = loadRegistry();
  if (json) { console.log(JSON.stringify(reg, null, 2)); return 0; }
  if (!reg.strings.length) { console.error('  no registry yet — run: atris strings scan'); return 2; }
  const top = Number((argv[argv.indexOf('--top') + 1]) || 30);
  console.log(`\n  ${reg.strings.length} strings (scanned ${reg.scannedAt || '?'}), top ${Math.min(top, reg.strings.length)} by use:\n`);
  for (const s of reg.strings.slice(0, top)) console.log(`  ${String(s.count).padStart(3)}×  ${JSON.stringify(s.text)}`);
  console.log('');
  return 0;
}

function stringsCommand(argv) {
  const sub = argv[0];
  const rest = argv.slice(1);
  if (sub === 'scan') return scan(rest);
  if (sub === 'variants' || sub === 'dupes') return variants(rest);
  if (sub === 'term' || sub === 'terms') return term(rest);
  if (sub === 'check' || sub === 'gate') return check(rest);
  if (sub === 'list' || sub === 'ls') return list(rest);
  console.log(`
  atris strings — a content design system from your live codebase (no LLM)

    atris strings scan [path]      extract user-facing strings -> .atris/strings.json
    atris strings variants         the same string written N different ways (pick one)
    atris strings term --ban <a> --prefer <b> [--why "..."]   codify a preferred term
    atris strings term --list      show the preferred terms
    atris strings check [--staged] gate: flag banned terms in changed lines (exit 1)
    atris strings list [--top N]   the registry, most-used first
    add --json to scan/variants/check/list for machine output

  Pairs with 'atris slop' (how copy reads) — strings governs what words you ship.
  The registry lives in .atris/strings.json. Wire 'check --staged' into the pre-commit gate.
`);
  return 0;
}

module.exports = {
  stringsCommand, scan, variants, term, check, list,
  isUserFacing, extractStrings, normalize, variantClusters,
  loadRegistry, saveRegistry, walk, CODE_EXTS, TEXT_EXTS,
};
