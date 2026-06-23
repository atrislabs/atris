// atris slop — deterministic frontend-slop detector (no LLM).
//
// Steal-from-Impeccable, the Atris way: makes "looks AI-generated" concrete and
// CHECKABLE. A failure is a fact (file:line + rule), not a taste opinion — so it
// drops straight into the autopilot/review verification gate and CI. Each finding
// is the seed of a typed lesson; the ruleset is meant to GROW from lessons.md
// rather than be hand-curated forever.
//
// Zero external deps (Node built-ins only) — repo contract.
//
// Usage:
//   atris slop detect [path]        # scan a file or dir (default: .)
//   atris slop detect src/ --json   # machine output for CI / the loop
//   atris slop detect src/ --quiet  # only print the summary line
//
// Exit code: 0 = clean, 1 = slop found, 2 = bad usage. CI/PR gates read this.

const fs = require('fs');
const path = require('path');

const SCAN_EXTS = new Set(['.css', '.scss', '.sass', '.less', '.tsx', '.jsx', '.ts', '.js', '.mjs', '.html', '.vue', '.svelte', '.astro',
  '.md', '.mdx', '.txt']); // prose too: the voice doctrine (em-dash, hype-copy) is enforceable, not just advice
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.astro', 'coverage', '.cache', 'out', 'vendor']);

// Each rule is deterministic: a regex + a one-line why. severity drives the icon.
// Kept high-precision on purpose — a noisy gate gets muted, and a muted gate is dead.
const RULES = [
  { id: 'ai-gradient-text', sev: 'error',
    re: /(text-transparent[^"'`]{0,40}bg-clip-text|bg-clip-text[^"'`]{0,40}text-transparent|-webkit-text-fill-color:\s*transparent|background-clip:\s*text)/i,
    why: 'gradient-filled text headline: the #1 generated-look tell' },
  { id: 'ai-purple-gradient', sev: 'error',
    re: /((from|via|to)-(purple|violet|indigo|fuchsia)-\d{2,3}\b|linear-gradient\([^)]*(#6366f1|#8b5cf6|#a855f7|#7c3aed|#4f46e5|\bpurple\b|\bviolet\b|\bindigo\b))/i,
    why: 'purple/indigo gradient: default "AI startup" palette' },
  { id: 'ai-indigo-brand', sev: 'warn',
    re: /(#6366f1|#4f46e5|#4338ca|(?:bg|text|border|from|to|ring)-indigo-(?:500|600|700)\b)/i,
    why: 'canonical AI indigo used as brand color' },
  { id: 'glassmorphism', sev: 'warn',
    re: /(backdrop-blur(?:-\w+)?\b|backdrop-filter:\s*blur)/i,
    why: 'glassmorphism (frosted blur): overused default' },
  { id: 'over-rounding', sev: 'warn',
    re: /(rounded-(?:3xl|\[(?:[2-9]\d?|1\d\d)(?:px|rem)\])|border-radius:\s*(?:2[4-9]|[3-9]\d|\d{3})px|border-radius:\s*(?:[2-9](?:\.\d+)?)rem)/i,
    why: 'over-rounded corners (>=24px / rounded-3xl)' },
  { id: 'mega-shadow', sev: 'warn',
    re: /(shadow-2xl\b|box-shadow:\s*0\s+\d{2,}px)/i,
    why: 'oversized generic drop shadow (depth-by-blur)' },
  { id: 'side-stripe-card', sev: 'warn',
    re: /border-(?:left|l)-(?:4|8|\[\d+px\])\b|border-left:\s*[3-9]px\s+solid/i,
    why: 'accent side-stripe on a card: generated layout reflex' },
  { id: 'transition-all', sev: 'warn',
    re: /\btransition-all\b|transition:\s*all\b/i,
    why: 'transition-all: animate-everything laziness, not intent' },
  { id: 'pulse-animation', sev: 'warn',
    re: /animation:[^;]*\binfinite\b|@keyframes\s+(pulse|ping|blink|glow|throb)\b|\banimate-(pulse|ping|bounce)\b/i,
    why: 'looping pulse/ping/glow animation: distracting live-status reflex' },
  { id: 'eyebrow-caps', sev: 'warn',
    re: /text-transform:\s*uppercase\b|\buppercase\b[^"'`]{0,30}tracking-|tracking-[^"'`]{0,30}\buppercase\b/i,
    why: 'tracked all-caps eyebrow/label: dated reflex; use sentence case' },
  { id: 'decorative-emoji', sev: 'warn',
    re: /[✨\u{1F680}\u{1F4A1}\u{1F525}\u{1F389}⚡\u{1F31F}\u{1FA84}\u{1F4AB}\u{1F44B}]/u,
    why: 'decorative emoji in UI copy' },
  { id: 'em-dash', sev: 'warn',
    re: /—/,
    why: 'em dash: a top AI-writing tell; use a comma, colon, or period' },
  { id: 'hype-copy', sev: 'error',
    re: /\b(boost your productivity|supercharge|unleash|game[- ]?chang(?:er|ing)|seamlessly|effortlessly|revolutioniz(?:e|ing)|take your .{1,30} to the next level|elevate your|cutting[- ]edge|powered by ai|next[- ]generation)\b/i,
    why: 'hype/marketing slop phrase: say the specific thing instead' },
];

const ICON = { error: '✗', warn: '⚠' }; // ✗  ⚠

function walk(target, out) {
  let stat;
  try { stat = fs.statSync(target); } catch { return out; }
  if (stat.isFile()) {
    if (SCAN_EXTS.has(path.extname(target))) out.push(target);
    return out;
  }
  if (stat.isDirectory()) {
    if (SKIP_DIRS.has(path.basename(target))) return out;
    for (const name of fs.readdirSync(target)) {
      if (name.startsWith('.') && name !== '.') continue;
      walk(path.join(target, name), out);
    }
  }
  return out;
}

function scanFile(file) {
  const findings = [];
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return findings; }
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const rule of RULES) {
      const m = rule.re.exec(line);
      if (m) {
        findings.push({
          file, line: i + 1, rule: rule.id, sev: rule.sev, why: rule.why,
          snippet: m[0].trim().slice(0, 48),
        });
      }
    }
  }
  return findings;
}

function detect(argv) {
  const json = argv.includes('--json');
  const quiet = argv.includes('--quiet');
  const target = argv.find((a) => !a.startsWith('-')) || '.';

  const files = walk(path.resolve(target), []);
  const findings = files.flatMap(scanFile);
  const errors = findings.filter((f) => f.sev === 'error').length;

  if (json) {
    console.log(JSON.stringify({
      ok: findings.length === 0, scanned: files.length,
      slop: findings.length, errors,
      findings: findings.map((f) => ({ ...f, file: path.relative(process.cwd(), f.file) })),
    }, null, 2));
    return findings.length ? 1 : 0;
  }

  const rel = (f) => path.relative(process.cwd(), f);
  if (!quiet) {
    if (!findings.length) {
      console.log(`\n  ✓ clean — no slop tells in ${files.length} file${files.length === 1 ? '' : 's'}`);
    } else {
      console.log('');
      const w = Math.max(...findings.map((f) => `${rel(f.file)}:${f.line}`.length));
      for (const f of findings) {
        const loc = `${rel(f.file)}:${f.line}`.padEnd(w);
        console.log(`  ${ICON[f.sev]} ${loc}  ${f.rule.padEnd(20)} ${f.why}`);
      }
    }
  }
  if (findings.length) {
    console.log(`\n  ${findings.length} slop tell${findings.length === 1 ? '' : 's'} (${errors} error) · exit 1\n`);
  } else if (quiet) {
    console.log(`  ✓ clean · exit 0`);
  }
  return findings.length ? 1 : 0;
}

function slopCommand(argv) {
  const sub = argv[0];
  if (!sub || sub === 'detect' || sub.startsWith('-') || !['detect', 'rules', 'help'].includes(sub)) {
    // default + `detect`: scan. Bare `atris slop` scans cwd too.
    const rest = sub === 'detect' ? argv.slice(1) : argv;
    return detect(rest);
  }
  if (sub === 'rules') {
    console.log('\n  atris slop — deterministic rules:\n');
    for (const r of RULES) console.log(`  ${ICON[r.sev]} ${r.id.padEnd(20)} ${r.why}`);
    console.log('');
    return 0;
  }
  // help
  console.log(`
  atris slop — deterministic frontend-slop detector (no LLM)

    atris slop detect [path]     scan a file or dir (default: .)
    atris slop detect src --json machine output for CI / the loop
    atris slop rules             list the active rules

  exit 0 = clean, 1 = slop found. Wire into PR checks and the autopilot gate.
`);
  return 0;
}

module.exports = { slopCommand, detect, scanFile, RULES };
