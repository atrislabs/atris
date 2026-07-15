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
const { execFileSync } = require('child_process');

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
  { id: 'hover-lift', sev: 'warn',
    re: /\bhover:(?:-translate-y-(?:0\.5|[1-9]\d?)|scale-1(?:1[0-9]|[2-9]\d))\b/,
    why: 'card lifts/over-grows on hover (translate-y shift or scale past 1.05): the generated-card reflex; keep hover scale subtle and never shift content' },
  { id: 'eyebrow-caps', sev: 'warn',
    re: /text-transform:\s*uppercase\b|\buppercase\b[^"'`]{0,30}tracking-|tracking-[^"'`]{0,30}\buppercase\b/i,
    why: 'tracked all-caps eyebrow/label: dated reflex; use sentence case' },
  { id: 'decorative-emoji', sev: 'warn',
    re: /[✨\u{1F680}\u{1F4A1}\u{1F525}\u{1F389}⚡\u{1F31F}\u{1FA84}\u{1F4AB}\u{1F44B}]/u,
    why: 'decorative emoji in UI copy' },
  { id: 'em-dash', sev: 'warn',
    re: /—/,
    fix: (s) => s.replace(/\s*—\s*/g, ', '), // safe deterministic repair (prose)
    why: 'em dash: a top AI-writing tell; use a comma, colon, or period' },
  { id: 'hype-copy', sev: 'error',
    re: /\b(boost your productivity|supercharge|unleash|game[- ]?chang(?:er|ing)|seamlessly|effortlessly|revolutioniz(?:e|ing)|take your .{1,30} to the next level|elevate your|cutting[- ]edge|powered by ai|next[- ]generation)\b/i,
    why: 'hype/marketing slop phrase: say the specific thing instead' },
  { id: 'kicker-dot-caps', sev: 'error',
    re: /[●◉]\s*[A-Z][A-Z0-9]+(?:\s+[A-Z0-9]+)*\b/,
    notFiles: /\.(md|mdx|txt)$/i, // prose/wireframe docs use ● as radio buttons and transport glyphs
    why: 'dot char + all-caps label: the status-dot eyebrow kicker, the #1 banned hero pattern' },
];

// Pair rules: two regexes that must BOTH hit within a small line window. Catches
// composites that span JSX lines (a dot element on one line, its label on the next).
const PAIR_RULES = [
  { id: 'hero-kicker', sev: 'error', span: 4,
    a: /rounded-full[^"'`]{0,80}\b[wh]-(?:1(?:\.5)?|2(?:\.5)?|3)\b|\b[wh]-(?:1(?:\.5)?|2(?:\.5)?|3)\b[^"'`]{0,80}rounded-full/i,
    b: /font-mono|tracking-(?:wide(?:r|st)?|\[)|text-\[?1[01]px|letter-spacing:\s*0?\.\d/i,
    why: 'tiny status dot next to a small mono/tracked kicker label: banned hero-kicker composite' },
];

const ICON = { error: '✗', warn: '⚠' }; // ✗  ⚠

const PROJECT_RULES_FILE = path.join('.atris', 'slop.rules.json');

// Compounding: projects grow their own anti-slop ruleset in .atris/slop.rules.json.
// Each entry: { id, pattern, flags?, why?, sev? }. Loaded on top of the built-ins.
function loadProjectRules(root = process.cwd()) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(root, PROJECT_RULES_FILE), 'utf8'));
    const arr = Array.isArray(raw) ? raw : (raw.rules || []);
    return arr.map((r) => {
      if (!r || !r.id || !r.pattern) return null;
      let re; try { re = new RegExp(r.pattern, r.flags || 'i'); } catch { return null; }
      return { id: r.id, sev: r.sev === 'error' ? 'error' : 'warn', re, why: r.why || r.id, project: true };
    }).filter(Boolean);
  } catch { return []; }
}

function addProjectRule(rule, root = process.cwd()) {
  const file = path.join(root, PROJECT_RULES_FILE);
  let arr = [];
  try { const raw = JSON.parse(fs.readFileSync(file, 'utf8')); arr = Array.isArray(raw) ? raw : (raw.rules || []); } catch {}
  arr = arr.filter((r) => r.id !== rule.id);
  arr.push(rule);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(arr, null, 2) + '\n');
  return file;
}

// Map<absFile, Set<changedLineNumber>> from the working-tree (or --cached) git diff.
function gitChangedLines(staged, cwd = process.cwd()) {
  const map = new Map();
  let out;
  try { out = execFileSync('git', ['diff', '--unified=0', ...(staged ? ['--cached'] : [])], { encoding: 'utf8', cwd }); }
  catch { return map; }
  let cur = null;
  for (const line of out.split('\n')) {
    const f = line.match(/^\+\+\+ b\/(.+)$/);
    if (f) { cur = path.resolve(cwd, f[1]); map.set(cur, map.get(cur) || new Set()); continue; }
    const h = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (h && cur) { const start = +h[1], count = h[2] != null ? +h[2] : 1; for (let i = 0; i < count; i++) map.get(cur).add(start + i); }
  }
  return map;
}

// Install a pre-commit hook that gates staged changes through `atris slop detect --staged`.
// Idempotent and non-destructive: appends a marked block, skips gracefully if atris is absent.
function installHook(root = process.cwd()) {
  if (!fs.existsSync(path.join(root, '.git'))) throw new Error('not a git repo (no .git here)');
  const hookDir = path.join(root, '.git', 'hooks');
  fs.mkdirSync(hookDir, { recursive: true });
  const hookPath = path.join(hookDir, 'pre-commit');
  const marker = '# atris slop gate';
  let content = '';
  try { content = fs.readFileSync(hookPath, 'utf8'); } catch {}
  if (content.includes(marker)) return { hookPath, already: true };
  if (!content) content = '#!/bin/sh\n';
  if (!content.endsWith('\n')) content += '\n';
  content += `\n${marker}\nif command -v atris >/dev/null 2>&1; then atris slop detect --staged --quiet || exit 1; fi\n`;
  fs.writeFileSync(hookPath, content);
  fs.chmodSync(hookPath, 0o755);
  return { hookPath, already: false };
}

// Apply every fixable rule's safe transform in place. Returns { fixedCount, fixedFiles }.
function applyFixes(files, rules) {
  const fixable = rules.filter((r) => typeof r.fix === 'function');
  let fixedCount = 0; const fixedFiles = [];
  for (const file of files) {
    let text; try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const lines = text.split('\n');
    let touched = false;
    for (let i = 0; i < lines.length; i++) {
      let line = lines[i];
      for (const r of fixable) { if (r.re.test(line)) { const nl = r.fix(line); if (nl !== line) { line = nl; fixedCount++; } } }
      if (line !== lines[i]) { lines[i] = line; touched = true; }
    }
    if (touched) { fs.writeFileSync(file, lines.join('\n')); fixedFiles.push(file); }
  }
  return { fixedCount, fixedFiles };
}

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

function scanFile(file, rules = RULES, pairRules = PAIR_RULES) {
  const findings = [];
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return findings; }
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const rule of rules) {
      if (rule.notFiles && rule.notFiles.test(file)) continue;
      const m = rule.re.exec(line);
      if (m) {
        findings.push({
          file, line: i + 1, rule: rule.id, sev: rule.sev, why: rule.why,
          snippet: m[0].trim().slice(0, 48),
        });
      }
    }
  }
  for (const pr of pairRules) {
    for (let i = 0; i < lines.length; i++) {
      if (!pr.a.test(lines[i])) continue;
      const lo = Math.max(0, i - pr.span), hi = Math.min(lines.length - 1, i + pr.span);
      for (let j = lo; j <= hi; j++) {
        if (pr.b.test(lines[j])) {
          findings.push({
            file, line: i + 1, rule: pr.id, sev: pr.sev, why: pr.why,
            snippet: lines[i].trim().slice(0, 48),
          });
          break;
        }
      }
    }
  }
  return findings;
}

function detect(argv) {
  const json = argv.includes('--json');
  const quiet = argv.includes('--quiet');
  const doFix = argv.includes('--fix');
  const staged = argv.includes('--staged');
  const diffMode = staged || argv.includes('--diff');
  const rules = RULES.concat(loadProjectRules());

  // pick the file set: a git diff (changed files) or a path walk
  let files, changed = null;
  if (diffMode) {
    changed = gitChangedLines(staged);
    files = [...changed.keys()].filter((f) => SCAN_EXTS.has(path.extname(f)) && fs.existsSync(f));
  } else {
    const target = argv.find((a) => !a.startsWith('-')) || '.';
    files = walk(path.resolve(target), []);
  }

  let fixed = null;
  if (doFix) {
    fixed = applyFixes(files, rules);
    if (!json && fixed.fixedCount) {
      console.log(`\n  ✎ fixed ${fixed.fixedCount} tell${fixed.fixedCount === 1 ? '' : 's'} in ${fixed.fixedFiles.length} file${fixed.fixedFiles.length === 1 ? '' : 's'}`);
    }
  }

  let findings = files.flatMap((f) => scanFile(f, rules));
  if (diffMode && changed) findings = findings.filter((f) => changed.get(f.file) && changed.get(f.file).has(f.line));
  const errors = findings.filter((f) => f.sev === 'error').length;

  if (json) {
    console.log(JSON.stringify({
      ok: findings.length === 0, scanned: files.length,
      mode: diffMode ? (staged ? 'staged' : 'diff') : 'path',
      fixed: fixed ? fixed.fixedCount : 0,
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
  if (!sub || sub === 'detect' || sub.startsWith('-') || !['detect', 'rules', 'help', 'hook', 'install-hook'].includes(sub)) {
    // default + `detect`: scan. Bare `atris slop` scans cwd too.
    const rest = sub === 'detect' ? argv.slice(1) : argv;
    return detect(rest);
  }
  if (sub === 'hook' || sub === 'install-hook') {
    try {
      const { hookPath, already } = installHook();
      console.log(already
        ? `\n  already installed: ${path.relative(process.cwd(), hookPath)}\n`
        : `\n  ✓ slop pre-commit gate installed: ${path.relative(process.cwd(), hookPath)}\n    every commit now runs: atris slop detect --staged\n`);
      return 0;
    } catch (e) { console.error(`  ${e.message}`); return 2; }
  }

  if (sub === 'rules') {
    if (argv.includes('--add')) {
      const rest = argv.slice(argv.indexOf('--add') + 1).filter((a) => !a.startsWith('-'));
      const [id, pattern, ...whyParts] = rest;
      if (!id || !pattern) { console.error('  usage: atris slop rules --add <id> <regex-pattern> <why...> [--sev error|warn]'); return 2; }
      let valid = true; try { new RegExp(pattern, 'i'); } catch { valid = false; }
      if (!valid) { console.error(`  invalid regex: ${pattern}`); return 2; }
      const sev = (argv[argv.indexOf('--sev') + 1] === 'error') ? 'error' : 'warn';
      const file = addProjectRule({ id, pattern, why: whyParts.join(' ') || id, sev });
      console.log(`  ✓ added project rule "${id}" to ${path.relative(process.cwd(), file)}`);
      return 0;
    }
    const project = loadProjectRules();
    console.log('\n  atris slop — deterministic rules:\n');
    for (const r of RULES) console.log(`  ${ICON[r.sev]} ${r.id.padEnd(20)} ${r.why}`);
    for (const r of project) console.log(`  ${ICON[r.sev]} ${r.id.padEnd(20)} ${r.why}  (project)`);
    console.log(`\n  ${RULES.length} built-in${project.length ? ` + ${project.length} project` : ''} rule${RULES.length + project.length === 1 ? '' : 's'}\n`);
    return 0;
  }
  // help
  console.log(`
  atris slop — deterministic slop detector + repairer (no LLM)

    atris slop detect [path]      scan a file or dir (default: .)
    atris slop detect --diff      scan only changed lines (commit/PR gate)
    atris slop detect --staged    scan only staged changes (pre-commit hook)
    atris slop detect --fix       auto-repair the safe tells (em dashes), report the rest
    atris slop detect [path] --json   machine output for CI / the loop
    atris slop rules              list active rules (built-in + project)
    atris slop rules --add <id> <pattern> <why>   grow the project ruleset
    atris slop hook               install a pre-commit gate (runs --staged)

  Project rules live in .atris/slop.rules.json and compound over time.
  exit 0 = clean, 1 = slop found. Wire into PR checks and the autopilot gate.
`);
  return 0;
}

module.exports = { slopCommand, detect, scanFile, RULES, PAIR_RULES, loadProjectRules, addProjectRule, gitChangedLines, applyFixes, installHook };
