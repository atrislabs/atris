// atris security-review, deterministic secrets / PII / privacy scan (no LLM).
//
// "Is this workspace safe to commit, publish, or hand to an autonomous loop?"
// Answers it with facts: file:line + rule + severity. Exit 1 on a HIGH finding,
// so it drops into the autopilot/mission/CI verification gate. `--json` emits a
// SOC 2 evidence artifact. Scans git-tracked files by default (what is exposed
// is what is committed), or a path you pass.
//
// Usage:
//   atris security-review                 scan tracked files (default)
//   atris security-review src/            scan a path
//   atris security-review --staged        scan staged changes (pre-commit gate)
//   atris security-review --json          machine output for CI / the loop
//   atris security-review --strict        also fail on MEDIUM (PII/paths)
//   atris security-review --deep          model-review prompt + evidence
//   atris security-review --update-baseline accept current findings
//   atris security-review hook            install a pre-commit gate
//   atris security-review audit           sentinel audit: engines hunt, a
//                                         different model verifies (see
//                                         lib/security-audit.js)
//
// Exit code: 0 = clean, 1 = active findings at/over the fail threshold, 2 = bad usage.

const fs = require('fs');
const path = require('path');
const {
  runScan,
  RULES,
  DEFAULT_BASELINE,
  SEVERITIES,
  SEVERITY_RANK,
  loadBaseline,
  writeBaseline,
  applyBaseline,
  shouldFail,
  scoreFindings,
  recordRun,
  buildLanding,
} = require('../lib/security-scan');

const ICON = { critical: '✗', high: '✗', medium: '!', low: '·', privacy: '✗', secret: '✗', pii: '!' };
const SEV_ORDER = { critical: 0, high: 1, medium: 2, low: 3 };

function parseArgs(argv) {
  const opts = {
    json: false,
    quiet: false,
    strict: false,
    staged: false,
    updateBaseline: false,
    noBaseline: false,
    deep: false,
    md: false,
    land: false,
    noRecord: false,
    baseline: DEFAULT_BASELINE,
    paths: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === 'scan') continue;
    if (arg === '--json') opts.json = true;
    else if (arg === '--quiet') opts.quiet = true;
    else if (arg === '--strict') opts.strict = true;
    else if (arg === '--staged') opts.staged = true;
    else if (arg === '--update-baseline') opts.updateBaseline = true;
    else if (arg === '--no-baseline') opts.noBaseline = true;
    else if (arg === '--deep') opts.deep = true;
    else if (arg === '--md' || arg === '--markdown') opts.md = true;
    else if (arg === '--land' || arg === '--landing') opts.land = true;
    else if (arg === '--no-record') opts.noRecord = true;
    else if (arg === '--baseline') {
      if (!argv[i + 1] || argv[i + 1].startsWith('-')) throw new Error('--baseline requires a path');
      opts.baseline = argv[++i];
    } else if (arg.startsWith('--baseline=')) {
      opts.baseline = arg.slice('--baseline='.length);
    } else if (arg.startsWith('-')) {
      throw new Error(`unknown flag: ${arg}`);
    } else {
      opts.paths.push(arg);
    }
  }
  if (opts.noBaseline && opts.updateBaseline) throw new Error('--update-baseline cannot be combined with --no-baseline');
  return opts;
}

function sortFindings(findings) {
  findings.sort((a, b) => (SEV_ORDER[a.sev] - SEV_ORDER[b.sev]) || a.file.localeCompare(b.file) || (a.line - b.line));
  return findings;
}

function failThreshold(strict) {
  return strict ? 'medium' : 'high';
}

function failingCount(findings, threshold) {
  return findings.filter((f) => SEVERITY_RANK[f.sev] >= SEVERITY_RANK[threshold]).length;
}

function applyBaselineOptions(root, rawFindings, opts) {
  if (opts.noBaseline) {
    const active = applyBaseline(rawFindings, []);
    return { ...active, baseline: { enabled: false, path: null, updated: false } };
  }

  let baseline = loadBaseline(root, opts.baseline);
  let updated = false;
  if (opts.updateBaseline) {
    baseline = writeBaseline(root, rawFindings, opts.baseline);
    updated = true;
  }
  const applied = applyBaseline(rawFindings, baseline.fingerprints);
  return {
    ...applied,
    baseline: {
      enabled: true,
      path: path.relative(root, baseline.file) || opts.baseline,
      updated,
      fingerprints: baseline.fingerprints.length,
    },
  };
}

function securityReviewCommand(argv = []) {
  const sub = argv[0];
  if (sub === 'audit') return auditCommand(argv.slice(1));
  if (sub === 'help' || argv.includes('-h') || argv.includes('--help')) return printHelp();
  if (sub === 'rules') return printRules();
  if (sub === 'hook' || sub === 'install-hook') return installHook();

  const root = process.cwd();
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    console.error(`security-review: ${e.message}`);
    return 2;
  }

  let raw;
  let result;
  try {
    raw = runScan({ root, paths: opts.paths, staged: opts.staged });
    result = applyBaselineOptions(root, raw.findings, opts);
  } catch (e) {
    console.error(`security-review: ${e.message}`);
    return 2;
  }

  const findings = sortFindings(result.findings);
  const allFindings = sortFindings(result.allFindings);
  const counts = result.counts;
  const threshold = failThreshold(opts.strict);
  const failing = failingCount(findings, threshold);
  const ok = !shouldFail(findings, threshold);

  // Flight recorder + landing: the loop appends one row per run; the landing
  // compares this run to the last one. buildLanding must read the ledger BEFORE
  // recordRun appends this run.
  const scanResult = { findings, counts, scanned: raw.scanned, suppressed: result.suppressed };
  const landing = buildLanding(root, scanResult, { failOn: threshold });
  if (!opts.noRecord) recordRun(root, scanResult, { failOn: threshold });

  if (opts.json) {
    console.log(JSON.stringify({
      ok,
      scanned: raw.scanned,
      counts,
      counts_all: result.countsAll,
      suppressed: result.suppressed,
      baseline: result.baseline,
      score: scoreFindings(findings),
      score_all: scoreFindings(allFindings),
      fail_threshold: threshold,
      landing,
      findings,
      deep_review: opts.deep ? deepReviewPayload({ findings, counts, scanned: raw.scanned, suppressed: result.suppressed }) : undefined,
      generated_for: 'soc2-evidence',
    }, null, 2));
    return ok ? 0 : 1;
  }

  if (opts.md) {
    console.log(renderMarkdownReport({
      findings, allFindings, counts, countsAll: result.countsAll, scanned: raw.scanned,
      threshold, failing, baseline: result.baseline, suppressed: result.suppressed,
      includeDeep: opts.deep,
    }));
    return ok ? 0 : 1;
  }

  if (opts.deep) {
    console.log(renderDeepReview({
      findings, counts, scanned: raw.scanned, threshold, suppressed: result.suppressed, baseline: result.baseline,
    }));
    return ok ? 0 : 1;
  }

  if (opts.land) {
    console.log(renderLanding(landing, threshold));
    return ok ? 0 : 1;
  }

  if (!opts.quiet) {
    console.log('\n  ◉ atris security review');
    if (!findings.length) {
      // Fixed rules find only the shapes they know, so this says what was
      // checked, never "clean".
      console.log(`\n  ✓ no matches for ${require('../lib/security-scan').RULES.length} fixed rules (secrets, personal data, sensitive files) in ${raw.scanned} tracked file${raw.scanned === 1 ? '' : 's'}`);
      if (result.suppressed) console.log(`  ${result.suppressed} accepted finding${result.suppressed === 1 ? '' : 's'} suppressed by ${result.baseline.path}`);
      console.log('');
      return 0;
    }
    console.log('');
    const w = Math.max(...findings.map((f) => `${f.file}${f.line ? ':' + f.line : ''}`.length));
    for (const f of findings) {
      const loc = `${f.file}${f.line ? ':' + f.line : ''}`.padEnd(w);
      console.log(`  ${ICON[f.sev] || '·'} ${f.sev.toUpperCase().padEnd(6)} ${loc}  ${f.rule.padEnd(22)} ${f.why}`);
    }
  }
  console.log(`\n  ${counts.critical || 0} critical · ${counts.high || 0} high · ${counts.medium || 0} medium · ${counts.low || 0} low across ${raw.scanned} file${raw.scanned === 1 ? '' : 's'}`);
  if (result.suppressed) console.log(`  ${result.suppressed} accepted finding${result.suppressed === 1 ? '' : 's'} suppressed by ${result.baseline.path}`);
  if (result.baseline.updated) console.log(`  baseline updated: ${result.baseline.path} (${result.baseline.fingerprints} fingerprint${result.baseline.fingerprints === 1 ? '' : 's'})`);
  if (failing) {
    console.log(`  ${failing} finding${failing === 1 ? '' : 's'} at/over the ${threshold.toUpperCase()} threshold · exit 1`);
    console.log('  fix or suppress (trailing `atris-allow-secret`), then re-run.\n');
  } else {
    console.log(`  no findings at the ${threshold.toUpperCase()} threshold · exit 0\n`);
  }
  return ok ? 0 : 1;
}

// The landing: short, true, decision-ready. What you read after the overnight
// loop, the opposite of a finding dump.
function renderLanding(landing, threshold) {
  // Local calendar day; toISOString is UTC and dates an evening run
  // tomorrow anywhere west of Greenwich.
  const now = new Date();
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const L = ['', `  ✈ security landing, ${date}`, ''];
  if (landing.cleared) {
    L.push(`  CLEARED TO SHIP    no unresolved findings at the ${threshold.toUpperCase()} line from ${require('../lib/security-scan').RULES.length} fixed rules`);
  } else {
    const n = landing.open.length;
    L.push(`  HOLD               ${n} finding${n === 1 ? '' : 's'} need a decision before ship`);
  }
  L.push('');
  if (landing.hadPrevRun) {
    L.push('  since last run:');
    L.push(`    fixed     ${landing.fixed}`);
    L.push(`    new       ${landing.appeared}`);
    L.push(`    accepted  ${landing.accepted}  (known-safe, in baseline)`);
  } else {
    L.push(`  first run:  ${landing.open.length} open · ${landing.accepted} accepted (baseline)`);
  }
  L.push('');
  if (landing.open.length) {
    L.push('  needs you:');
    for (const f of landing.open.slice(0, 10)) {
      L.push(`    ${f.sev.toUpperCase().padEnd(8)} ${f.file}${f.line ? ':' + f.line : ''}, ${f.why}`);
    }
    if (landing.open.length > 10) L.push(`    … and ${landing.open.length - 10} more`);
  } else {
    L.push('  needs you:  nothing');
  }
  L.push('');
  if (landing.trend.length > 1) {
    const a = landing.trend[0], b = landing.trend[landing.trend.length - 1];
    const da = a.critical + a.high, db = b.critical + b.high;
    const dir = db < da ? 'improving' : db > da ? 'worsening' : 'steady';
    L.push(`  posture: critical ${a.critical}→${b.critical}, high ${a.high}→${b.high} over ${landing.trend.length} runs (${dir})`);
  } else {
    L.push(`  posture: ${landing.runs} run${landing.runs === 1 ? '' : 's'} recorded · scanned ${landing.scanned} files`);
  }
  L.push('');
  return L.join('\n');
}

function printRules() {
  console.log('\n  atris security-review, deterministic rules:\n');
  for (const sev of SEVERITIES) {
    for (const r of RULES.filter((rule) => rule.sev === sev)) {
      console.log(`  ${r.sev.toUpperCase().padEnd(8)} ${r.cat.padEnd(8)} ${r.id.padEnd(22)} ${r.why}`);
    }
  }
  console.log(`\n  ${RULES.length} rules + tracked-sensitive-file check. Suppress a line with a trailing \`atris-allow-secret\`.\n`);
  return 0;
}

const DEEP_DIMENSIONS = [
  ['secrets & keys', 'Look for real keys, tokens, private keys, credential files, and places where logs or docs could expose them.'],
  ['who-can-do-what', 'Check whether users, agents, missions, and local commands can only do the actions they should be allowed to do.'],
  ['untrusted input to code/shell/path/web requests', 'Trace user-controlled values into eval, new Function, child_process, file paths, URLs, redirects, and fetch/request calls.'],
  ['data exposure', 'Check logs, responses, reports, task state, prompts, and errors for personal data, secrets, or private workspace paths.'],
  ['dependencies', 'Check package and script changes for risky install hooks, unpinned tools, vendored code, or unexpected network execution.'],
  ['crypto & randomness', 'Check token generation, signing, hashing, random IDs, and compare logic for weak or predictable behavior.'],
  ['config & defaults', 'Check debug flags, CORS, open ports, default credentials, unsafe local paths, and flags that bypass safety gates.'],
];

function evidenceLines(findings, limit = 80) {
  if (!findings.length) return ['- No deterministic findings after baseline suppression.'];
  return findings.slice(0, limit).map((f) => {
    const loc = `${f.file}${f.line ? ':' + f.line : ''}`;
    return `- ${f.sev.toUpperCase()} ${loc} ${f.rule}: ${f.why}`;
  });
}

function deepReviewPayload({ findings, counts, scanned, suppressed }) {
  return {
    instruction: 'Answer each dimension with PASS or CONCERN. If CONCERN, cite file:line and the concrete risk. Do not speculate beyond the code.',
    dimensions: DEEP_DIMENSIONS.map(([name, check]) => ({ name, check })),
    evidence: {
      scanned,
      counts,
      suppressed,
      findings,
    },
  };
}

function renderDeepReview({ findings, counts, scanned, threshold, suppressed, baseline }) {
  const lines = [
    '# Atris Deep Security Review',
    '',
    'Use this as a second-pass review prompt for a capable model.',
    'Answer every dimension with PASS or CONCERN, then give the file:line evidence.',
    'Do not invent issues. If the code does not prove the issue, mark PASS or say what proof is missing.',
    '',
    'Deterministic evidence:',
    `- scanned files: ${scanned}`,
    `- active counts: ${counts.critical || 0} critical, ${counts.high || 0} high, ${counts.medium || 0} medium, ${counts.low || 0} low`,
    `- fail threshold: ${threshold}`,
    `- suppressed by baseline: ${suppressed}`,
    `- baseline: ${baseline.enabled ? baseline.path : 'off'}`,
    '',
    'Findings:',
    ...evidenceLines(findings),
    '',
    'Review dimensions:',
  ];
  for (const [name, check] of DEEP_DIMENSIONS) {
    lines.push('', `## ${name}`, check, 'Answer: PASS or CONCERN', 'Specific evidence:');
  }
  return `${lines.join('\n')}\n`;
}

function renderMarkdownReport({ findings, allFindings, counts, countsAll, scanned, threshold, failing, baseline, suppressed, includeDeep }) {
  const status = failing ? 'FAIL' : 'PASS';
  const lines = [
    '# Atris Security Review',
    '',
    `Status: ${status}`,
    `Fail threshold: ${threshold}`,
    `Scanned files: ${scanned}`,
    `Baseline: ${baseline.enabled ? baseline.path : 'off'}`,
    `Suppressed: ${suppressed}`,
    '',
    '## Active Counts',
    '',
    `- critical: ${counts.critical || 0}`,
    `- high: ${counts.high || 0}`,
    `- medium: ${counts.medium || 0}`,
    `- low: ${counts.low || 0}`,
    `- score: ${scoreFindings(findings)}`,
    '',
    '## All Counts',
    '',
    `- critical: ${countsAll.critical || 0}`,
    `- high: ${countsAll.high || 0}`,
    `- medium: ${countsAll.medium || 0}`,
    `- low: ${countsAll.low || 0}`,
    `- score: ${scoreFindings(allFindings)}`,
    '',
    '## Findings',
    '',
    ...evidenceLines(findings),
  ];
  if (includeDeep) {
    lines.push('', '## Deep Review Prompt', '', renderDeepReview({
      findings, counts, scanned, threshold, suppressed, baseline,
    }).trim());
  }
  return `${lines.join('\n')}\n`;
}

function installHook() {
  const root = process.cwd();
  const hookDir = path.join(root, '.git', 'hooks');
  try {
    fs.mkdirSync(hookDir, { recursive: true });
    const hookPath = path.join(hookDir, 'pre-commit');
    const marker = '# atris security gate';
    let content = '';
    try { content = fs.readFileSync(hookPath, 'utf8'); } catch {}
    if (content.includes(marker)) { console.log(`\n  already installed: ${path.relative(root, hookPath)}\n`); return 0; }
    if (!content) content = '#!/bin/sh\n';
    if (!content.endsWith('\n')) content += '\n';
    content += `\n${marker}\nif command -v atris >/dev/null 2>&1; then atris security-review --staged --quiet || exit 1; fi\n`;
    fs.writeFileSync(hookPath, content);
    fs.chmodSync(hookPath, 0o755);
    console.log(`\n  ✓ security pre-commit gate installed: ${path.relative(root, hookPath)}\n    every commit now runs: atris security-review --staged\n`);
    return 0;
  } catch (e) { console.error(`  ${e.message}`); return 2; }
}

function parseAuditArgs(argv) {
  const opts = { profile: 'standard', scope: [], json: false, planOnly: false, budget: null, out: null, hunter: null, verifier: null, timeoutMs: null, engine: null, yes: false, upload: null, scheduled: false, with: [], ref: null, keepClones: false };
  const takes = (i, flag) => {
    if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`${flag} needs a value`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const [flag, inline] = arg.includes('=') && arg.startsWith('--') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, null];
    const value = () => (inline !== null ? inline : takes(i++, flag));
    if (flag === '--json') opts.json = true;
    else if (flag === '--plan' || flag === '--dry-run') opts.planOnly = true;
    else if (flag === '--quick' || flag === '--standard' || flag === '--deep') opts.profile = flag.slice(2);
    else if (flag === '--profile') opts.profile = value();
    else if (flag === '--budget') opts.budget = Number(value());
    else if (flag === '--out') opts.out = value();
    else if (flag === '--hunter') opts.hunter = value();
    else if (flag === '--verifier') opts.verifier = value();
    else if (flag === '--timeout') opts.timeoutMs = Number(value()) * 1000;
    else if (flag === '--engine') opts.engine = value();
    else if (flag === '--yes' || flag === '-y') opts.yes = true;
    else if (flag === '--no-upload') opts.upload = false;
    else if (flag === '--upload') opts.upload = true;
    else if (flag === '--scheduled') opts.scheduled = true;
    else if (flag === '--with') opts.with.push(value());
    else if (flag === '--ref') opts.ref = value();
    else if (flag === '--keep-clones') opts.keepClones = true;
    else if (arg.startsWith('-')) throw new Error(`unknown flag: ${arg}`);
    else opts.scope.push(arg);
  }
  const { PROFILES } = require('../lib/security-audit');
  if (!PROFILES.includes(opts.profile)) throw new Error(`--profile must be one of ${PROFILES.join(', ')}`);
  if (opts.budget !== null && (!Number.isInteger(opts.budget) || opts.budget < 1 || opts.budget > 500)) throw new Error('--budget must be a whole number from 1 to 500');
  if (opts.timeoutMs !== null && (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs < 10000)) throw new Error('--timeout is in seconds, at least 10');
  if (opts.engine !== null && !['atris', 'local'].includes(opts.engine)) throw new Error('--engine must be atris or local');
  return opts;
}

function tildePath(p) {
  const home = require('os').homedir();
  return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

// Before any wait: is each AI tool this review needs installed and signed
// in? A missing or signed-out tool stops here with one plain fix, instead of
// a long run that reads nothing. With two tools installed and one signed
// out, the signed-in one does the whole review and says so.
function enginePreflight(engines, { roles, token, env = process.env, signedIn } = {}) {
  const cloud = require('../lib/sentinel-cloud');
  const audit = require('../lib/security-audit');
  if (engines.chosen === 'none_installed') return { stop: cloud.noEngineMessage({ loggedIn: Boolean(token) }) };
  const names = [...new Set(Object.values(roles))].filter((n) => n && !audit.isHostedEngine(n));
  if (!names.length) return {};
  const missing = cloud.missingEngines(names, { env });
  if (missing.length) {
    return { stop: `\n  ${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} not installed on this computer, so nothing was reviewed.\n  install ${missing.length === 1 ? 'it' : 'them'}, or leave out --hunter and --verifier to use what is installed.\n` };
  }
  const seen = new Map();
  const check = (n) => {
    if (!seen.has(n)) seen.set(n, signedIn ? signedIn(n) : cloud.engineSignedIn(n, { env }));
    return seen.get(n);
  };
  const out = names.filter((n) => check(n) === false);
  if (!out.length) return {};
  // Only when the person named no tool: another installed, signed-in tool
  // takes the signed-out one's place.
  const alt = engines.chosen === 'default'
    ? ['codex', 'claude'].find((n) => !out.includes(n) && cloud.localEngineAvailable(n, { env }) && check(n) !== false)
    : null;
  if (alt) {
    return {
      roles: Object.fromEntries(Object.entries(roles).map(([k, n]) => [k, out.includes(n) ? alt : n])),
      note: `  ${out[0]} is installed but not signed in, so ${alt} does all of it.\n  to use both, sign in once with: ${cloud.signInHow(out[0])}`,
    };
  }
  return {
    stop: [
      '',
      ...out.map((n) => `  ${n} is installed but not signed in, so it cannot read your code.`),
      `  sign in once with: ${out.map(cloud.signInHow).join(', then ')}`,
      '  then run atris sentinel again. nothing was reviewed.',
      '',
    ].join('\n'),
  };
}

// The review logic speaks in its own terms (waves, hunters, candidates).
// The person sees what is happening in plain words, and a line every minute
// so a long wait is never silent.
function plainProgress(msg) {
  const s = String(msg);
  let m;
  if ((m = /^mapping (.+)$/.exec(s))) return `looking over ${m[1]}`;
  if ((m = /^wave (\d+): (\d+) hunters? on (\d+) areas? \((.+)\)$/.exec(s))) {
    const parts = `${m[3]} part${m[3] === '1' ? '' : 's'} of your code`;
    return m[1] === '1' ? `${m[4]} is reading ${parts}, looking for ways in` : `${m[4]} is reading ${parts} more`;
  }
  if ((m = /^critic (?:final|wave \d+): (\d+) gaps?$/.exec(s))) return m[1] === '0' ? null : `${m[1]} more spot${m[1] === '1' ? '' : 's'} worth a look`;
  if ((m = /^verifying (\d+) candidates? with (.+)$/.exec(s))) {
    return m[1] === '0' ? 'no possible problems to double-check' : `${m[2]} is double-checking ${m[1]} possible problem${m[1] === '1' ? '' : 's'}`;
  }
  if ((m = /^re-checking (\d+) open findings? from .+$/.exec(s))) return `checking ${m[1]} problem${m[1] === '1' ? '' : 's'} from your last review again`;
  return s;
}

function reviewProgress({ say = console.log, planOnly = false, everyMs = 60000, now = Date.now } = {}) {
  const started = now();
  let timer = null;
  if (!planOnly) {
    say('  reading your code. this takes a few minutes for a small project, longer for a big one.');
    say('  it only reads. nothing in your project changes.');
    timer = setInterval(() => {
      const min = Math.max(1, Math.round((now() - started) / 60000));
      say(`  · still working, ${min} min so far`);
    }, everyMs);
    if (timer.unref) timer.unref();
  }
  return {
    log(msg) { const line = plainProgress(msg); if (line) say(`  · ${line}`); },
    stop() { if (timer) clearInterval(timer); timer = null; },
  };
}

// True when a finished review read no code at all, fresh or carried over,
// including one that had nothing to read. Such a run says nothing about
// the code and must never look like a clean one.
function readNothing(meta) {
  const cov = (meta && meta.coverage) || {};
  return !(cov.fresh || 0) && !(cov.carried || 0);
}

const LANGUAGE_NAMES = {
  '.js': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript', '.jsx': 'JavaScript',
  '.ts': 'TypeScript', '.tsx': 'TypeScript', '.py': 'Python', '.rb': 'Ruby', '.erb': 'Ruby',
  '.go': 'Go', '.java': 'Java', '.php': 'PHP', '.rs': 'Rust',
  '.sh': 'shell scripts', '.bash': 'shell scripts', '.zsh': 'shell scripts',
  '.html': 'web pages', '.vue': 'Vue', '.svelte': 'Svelte',
};

function joinWords(words) {
  return words.length < 2 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

// Said when a review had nothing to read: before any call, any run folder
// and any upload. It is not a pass.
function nothingToReadText(nothing, where) {
  const exts = new Set(nothing.extensions || []);
  const known = Object.keys(LANGUAGE_NAMES).filter((e) => exts.has(e)).map((e) => LANGUAGE_NAMES[e]);
  const langs = [...new Set([...known, ...[...exts].filter((e) => !LANGUAGE_NAMES[e]).sort()])];
  const lines = [''];
  if (nothing.readable_files) {
    lines.push(`  nothing was reviewed at ${where}. none of its ${nothing.readable_files} code file${nothing.readable_files === 1 ? '' : 's'} has a place Sentinel checks for ways in (input, files, commands, logins, secrets, settings).`);
  } else {
    lines.push(`  nothing was reviewed: there is no code Sentinel can read at ${where}.`);
    lines.push(`  it reads ${joinWords(langs)}, plus GitHub workflows, Dockerfiles and settings files.`);
  }
  lines.push('  this is not a clean result. no AI tool was called and nothing was saved.', '');
  return lines.join('\n');
}

const INCOMPLETE_WORDS = {
  validation_budget_exhausted: 'the double-check stopped before it finished. it ran out of tool calls, or the checking tool did not answer',
  plan_only: 'plan only',
};

// The audit landing: what was found, how much was read, what is left.
function renderAuditLanding({ dir, meta, records }) {
  const warning = require('../lib/security-audit').sourceWarning(meta);
  if (warning) return `\n  ${warning} Earlier findings keep their previous status.\n  Run Sentinel again on stable source.\n  Report: ${tildePath(path.join(dir, 'REPORT.md'))}\n`;
  const rank = { critical: 0, high: 1, medium: 2, low: 3, informational: 4 };
  const sevRank = (r) => rank[(r.severity && r.severity.overall) || ''] ?? 5;
  const confirmed = records.filter((r) => r.verdict === 'confirmed').sort((a, b) => sevRank(a) - sevRank(b));
  const needs = records.filter((r) => r.verdict === 'needs_validation');
  const { isNote } = require('../lib/security-audit');
  const rejected = records.filter((r) => r.verdict === 'rejected' && !isNote(r));
  const notes = records.filter(isNote);
  const cov = meta.coverage;
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const L = ['', `  ◉ sentinel review · ${meta.repo || path.basename(String(meta.target || ''))}${meta.scope_paths.length ? ` · ${meta.scope_paths.join(', ')}` : ''}`, ''];
  const parts = Array.isArray(meta.parts) ? meta.parts : [];
  if (parts.length) {
    L.push(parts.length > 1 ? `  one system in ${parts.length} parts, reviewed together:` : '  reviewing:');
    for (const p of parts) {
      const where = p.source === 'git' ? `${p.url}${p.ref ? ` (${p.ref})` : ''}` : tildePath(p.path);
      L.push(`    ${p.name.padEnd(14)} ${where}${p.commit ? ` · ${p.commit.slice(0, 7)}` : ''}`);
    }
    L.push('');
  }
  if (meta.incomplete_reason === 'plan_only') {
    L.push(`  plan only. no AI tool was called. ${plural(cov.in_scope, 'part', 'parts')} of your code to read`);
    if (parts.length > 1) {
      const byPart = new Map(parts.map((p) => [p.name, 0]));
      for (const id of meta.plan.areas_by_part ? Object.keys(meta.plan.areas_by_part) : []) byPart.set(id, meta.plan.areas_by_part[id]);
      L.push(`  parts per place: ${[...byPart].map(([n, c]) => `${n} ${c}`).join(', ')}`);
    }
    const { hunters, hunters_needed: needed, verifyReserve } = meta.plan;
    L.push(`  a ${meta.profile} review may use up to ${meta.budget} AI tool calls${parts.length > 1 ? ` in total, shared by all ${parts.length} places` : ''}, ${verifyReserve} of them kept for double-checking`);
    if (hunters < 1) L.push('  that is too few to read anything. try --budget 8 or more');
    else L.push(needed <= hunters ? '  one review can read all of it' : `  about ${Math.ceil(needed / hunters)} reviews to read all of it. each one picks up where the last stopped`);
    L.push('  to run it, give the same command without --plan');
    L.push(`  plan saved at: ${tildePath(path.join(dir, 'REPORT.md'))}`, '');
    return L.join('\n');
  }
  const waiting = require('../lib/security-audit').waitingOf(meta);
  const unchecked = Array.isArray(meta.unchecked) ? meta.unchecked : [];
  const open = confirmed.length + waiting.length;
  const nothing = readNothing(meta);
  if (nothing) {
    L.push('  nothing was read, so this review says nothing about your code.');
    if (!(cov.in_scope || 0)) L.push(open ? '  none of the code here is in what this review checks. the open findings below carry over from the last review.' : '  there was no code here Sentinel can read.');
    else L.push(`  ${meta.engines.hunter} did not answer. check that it works and is signed in, then run atris sentinel again.`);
  }
  if (open) {
    const sev = meta.counts && meta.counts.severity ? meta.counts.severity : {};
    const sevText = ['critical', 'high', 'medium', 'low', 'informational'].filter((s) => sev[s]).map((s) => `${sev[s]} ${s}`).join(', ');
    L.push(`  ${open} confirmed${sevText ? ` (${sevText})` : ''}. each one was found, then double-checked by reading the code again:`);
  } else if (nothing) {
    // Said above: nothing was read, so there is no result to give.
  } else if (unchecked.length) {
    L.push('  no problem is double-checked yet. possible problems were found, listed below.');
  } else {
    L.push('  no problems found in the parts that were read.');
    L.push('  that does not prove there are none. it is what this review could see.');
  }
  for (const r of confirmed.slice(0, 6)) {
    const sink = r.trace[r.trace.length - 1];
    L.push(`    ${r.severity.overall.padEnd(8)} ${r.title} (${sink.file}:${sink.line})`);
  }
  for (const w of waiting.slice(0, 6)) L.push(`    ${w.severity.padEnd(8)} ${w.title} (last seen at ${w.location}, still open: ${w.why})`);
  const shown = Math.min(6, confirmed.length) + Math.min(6, waiting.length);
  if (open > shown) L.push(`    and ${open - shown} more in the report`);
  if (unchecked.length) {
    L.push(`  ${unchecked.length} lead${unchecked.length === 1 ? '' : 's'} not checked yet. ${unchecked.length === 1 ? 'it is' : 'they are'} not disproved; the next run checks ${unchecked.length === 1 ? 'it' : 'them'} first`);
    for (const u of unchecked.slice(0, 6)) L.push(`    unchecked ${u.title}${u.location ? ` (${u.location})` : ''}${u.severity ? `, ${u.severity} if real` : ''}`);
    if (unchecked.length > 6) L.push(`    and ${unchecked.length - 6} more in the report`);
    const serious = require('../lib/security-audit').seriousUnchecked(meta).length;
    if (serious) L.push(`  this review is not a pass: ${serious === unchecked.length ? (serious === 1 ? 'that lead' : `all ${serious}`) : serious} could be high or critical and ${serious === 1 ? 'was' : 'were'} never checked`);
  }
  if (needs.length) L.push(`  ${plural(needs.length, 'lead needs a fact only you know', 'leads need a fact only you know')}. ${needs.length === 1 ? 'it is' : 'they are'} in the report`);
  if (rejected.length) L.push(`  ${plural(rejected.length, 'possible problem was', 'possible problems were')} checked and ruled out`);
  if (cov.blocked) L.push(`  ${plural(cov.blocked, 'part', 'parts')} could not be settled from the code alone. the open question is in the report`);
  if (notes.length) L.push(`  ${plural(notes.length, 'hardening tip', 'hardening tips')} in the report (not problems)`);
  L.push('');
  if (!nothing) {
    const left = cov.deferred || 0;
    const read = (cov.fresh || 0) + (cov.carried || 0);
    L.push(`  read ${read} of ${cov.in_scope} part${cov.in_scope === 1 ? '' : 's'} of your code${cov.carried ? ` (${cov.carried} unchanged since last time)` : ''}${left ? `. run atris sentinel again to read the other ${left}` : ''}`);
  }
  const same = meta.engines.hunter === meta.engines.verifier;
  if (!nothing) L.push(`  ${same ? `${meta.engines.hunter} looked and double-checked, in separate sessions` : `${meta.engines.hunter} looked, ${meta.engines.verifier} double-checked`} · ${meta.invocations.used} of ${meta.budget} AI tool calls${meta.credits_used ? ` · ${meta.credits_used} credits used` : ''}`);
  if (meta.run_status === 'incomplete' && !nothing) L.push(`  stopped early: ${INCOMPLETE_WORDS[meta.incomplete_reason] || String(meta.incomplete_reason).replace(/_/g, ' ')}`);
  L.push(`  full report: ${tildePath(path.join(dir, 'REPORT.md'))}`);
  if (confirmed.length) L.push('  next: atris sentinel fix   writes a fix and a test on a new branch for you to review');
  else if (unchecked.length) L.push('  next: run atris sentinel again to double-check them');
  L.push('');
  return L.join('\n');
}

// Ask once on a terminal. Anything but y or yes is a no.
function askYesNo(question, { input = process.stdin, output = process.stdout } = {}) {
  return new Promise((resolve) => {
    const rl = require('readline').createInterface({ input, output });
    rl.question(question, (answer) => { rl.close(); resolve(/^\s*y(es)?\s*$/i.test(String(answer || ''))); });
  });
}

// A plan, a run that never finished, or a review that read nothing would
// show on the dashboard as an all-clear. None of them is saved.
function notUploadable(dir) {
  let meta = null;
  try { meta = JSON.parse(fs.readFileSync(path.join(dir, 'run-metadata.json'), 'utf8')); } catch {}
  if (!meta) return 'it has no readable summary';
  const warning = require('../lib/security-audit').sourceWarning(meta);
  if (warning) return warning;
  if (meta.incomplete_reason === 'plan_only') return 'it is a plan. nothing was read';
  if (!['complete', 'incomplete'].includes(meta.run_status) || !meta.finished_at) return 'that review never finished';
  const stillOpen = meta.counts && Number(meta.counts.confirmed) > 0;
  if (meta.mode !== 'recheck' && readNothing(meta) && !stillOpen) return 'that review read nothing, so it says nothing about your code';
  return null;
}

// Ask before anything is saved to the account (lib/sentinel-consent.js).
function uploadConsent(flag, o) {
  return require('../lib/sentinel-consent').uploadConsent(flag, o);
}

// The free checks of a timed run follow the same answer as its review.
function scheduledUpload(flag, approval, deps = {}) {
  if (flag !== null) return flag;
  if (typeof approval.upload === 'boolean') return approval.upload;
  if (!('upload' in approval)) return true;
  const consent = require('../lib/sentinel-consent');
  const env = deps.env || process.env;
  const fromEnv = consent.envChoice(env);
  return fromEnv !== null ? fromEnv : consent.savedChoice({ homeDir: deps.homeDir, env }) === true;
}

async function uploadAfterRun(dir, { token, quiet, cloud, root = null, env = process.env }) {
  const say = quiet ? (m) => console.error(m) : (m) => console.log(m);
  const why = notUploadable(dir);
  if (why) { say(`  nothing was saved to your atris account: ${why}`); return { ok: false, skipped: true, reason: why }; }
  const res = await cloud.uploadRun(dir, { token });
  if (res.ok) say('  saved the summary to your atris account: titles, file and line, counts. the summary holds no code. to stop saving: atris sentinel upload --never');
  else say(`  warning: could not save the summary to your atris account: ${res.reason}. the review itself is done`);
  if (res.ok && res.body) await sendFixedEvents(dir, res.body, { token, root, env, say });
  return res;
}

// Fixed findings also go to the events feed. The overview counts them as
// fixed today. A failure here never undoes the saved review.
async function sendFixedEvents(dir, body, { token, root, env, say }) {
  if (!body.findings.some((f) => f.status === 'fixed')) return null;
  let meta = null;
  try { meta = JSON.parse(fs.readFileSync(path.join(dir, 'run-metadata.json'), 'utf8')); } catch {}
  const target = root || (meta && meta.target) || process.cwd();
  let res;
  try {
    res = await require('../lib/sentinel-events').reportReviewFixes(target, body, { token, env, foundAt: meta && meta.prior_finished_at });
  } catch (e) { res = { ok: false, reason: e.message }; }
  if (res.ok && res.fixed) say(`  marked ${res.fixed} finding${res.fixed === 1 ? '' : 's'} fixed on your dashboard`);
  else if (!res.ok) say(`  warning: could not mark the fixed findings on your dashboard: ${res.reason}. run atris sentinel upload to try again`);
  return res;
}

async function auditUploadCommand(argv, deps) {
  const audit = require('../lib/security-audit');
  const cloud = deps.cloud || require('../lib/sentinel-cloud');
  // The saved answer to "save a summary to your account?".
  if (argv.includes('--always') || argv.includes('--never')) {
    if (argv.includes('--always') && argv.includes('--never')) { console.error('  pick --always or --never'); return 2; }
    const yes = argv.includes('--always');
    const consent = require('../lib/sentinel-consent');
    try { consent.saveChoice(yes, { homeDir: deps.homeDir, env: deps.env || process.env }); } catch (e) { console.error(`  could not save your answer: ${e.message}`); return 1; }
    console.log(yes
      ? '  each review now saves its summary to your atris account: titles, file and line, counts, never code. stop with: atris sentinel upload --never'
      : '  reviews now keep everything on this machine. nothing is saved to your atris account. change it with: atris sentinel upload --always');
    return 0;
  }
  const token = deps.token !== undefined ? deps.token : cloud.authToken();
  if (!token) { console.error('  log in first with atris login. then run atris sentinel upload again'); return 2; }
  const arg = argv.find((a) => !a.startsWith('-'));
  let dir = arg ? path.resolve(arg) : null;
  if (!dir) {
    const last = audit.latestRun(deps.root || process.cwd());
    if (!last) { console.error('  no sentinel review has run for this repo yet'); return 2; }
    dir = last.dir;
  }
  if (!fs.existsSync(path.join(dir, 'run-metadata.json'))) { console.error(`  ${tildePath(dir)} is not a sentinel run folder`); return 2; }
  const why = notUploadable(dir);
  if (why) { console.error(`  ${path.basename(dir)} was not saved: ${why}`); return 2; }
  const res = await cloud.uploadRun(dir, { token });
  if (!res.ok) { console.error(`  could not save ${path.basename(dir)}: ${res.reason}`); return 1; }
  console.log(`  saved ${path.basename(dir)} to your atris account. the summary holds no code`);
  if (res.body) await sendFixedEvents(dir, res.body, { token, root: null, env: deps.env || process.env, say: (m) => console.log(m) });
  return 0;
}

// Price one quick run on atris models for a folder without calling any
// model: the audit plans, the estimate is quoted, and the plan is dropped.
async function quoteQuickRun(target, { hunter, verifier, token, cloud }) {
  const audit = require('../lib/security-audit');
  let estimate = null;
  const res = await audit.runAudit({
    root: target, profile: 'quick', hunter, verifier,
    runJobs: async () => { throw new Error('no model call while pricing a schedule'); },
    confirmSpend: async (est) => { estimate = est; return false; },
  });
  if (res && res.nothing_to_read) throw new Error(`there is no code Sentinel can review in ${tildePath(target)}`);
  if (!estimate) throw new Error('could not plan a review for this folder');
  return cloud.quoteEstimate(estimate, { token });
}

async function auditScheduleCommand(argv, deps) {
  const cloud = deps.cloud || require('../lib/sentinel-cloud');
  const { installKeep, removeKeep } = require('../lib/campaign-keep');
  const uninstall = argv.includes('--uninstall');
  let every = 'day';
  let target = null;
  let engine = null;
  let maxCredits = null;
  let yes = false;
  let uploadFlag = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const [flag, inline] = a.startsWith('--') && a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, null];
    const value = () => (inline !== null ? inline : argv[++i]);
    if (flag === '--every') every = value();
    else if (flag === '--engine') engine = value();
    else if (flag === '--max-credits') maxCredits = Number(value());
    else if (flag === '--yes' || flag === '-y') yes = true;
    else if (flag === '--upload') uploadFlag = true;
    else if (flag === '--no-upload') uploadFlag = false;
    else if (flag === '--uninstall' || flag === '--install') continue;
    else if (a.startsWith('-')) { console.error(`  unknown flag: ${a}`); return 2; }
    else target = a;
  }
  if (!cloud.SCHEDULE_EVERY[every]) { console.error('  use --every day or --every week'); return 2; }
  if (engine !== null && engine !== 'atris' && engine !== 'local') { console.error('  --engine must be atris or local'); return 2; }
  if (maxCredits !== null && (!Number.isInteger(maxCredits) || maxCredits < 1)) { console.error('  --max-credits must be a whole number of credits, at least 1'); return 2; }
  target = path.resolve(target || deps.root || process.cwd());
  if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) { console.error(`  ${target} is not a folder`); return 2; }
  const atrisBin = deps.atrisBin || path.resolve(__dirname, '..', 'bin', 'atris.js');
  const plan = cloud.schedulePlan({ target, every, homeDir: deps.homeDir, platform: deps.platform, atrisBin, envPath: deps.envPath });
  const keepDeps = deps.spawn ? { spawn: deps.spawn } : {};
  if (uninstall) {
    // Same folder makes the same timer name, so --every does not matter here.
    const removed = removeKeep(plan, keepDeps);
    if (!removed.ok) { console.error(`  could not remove the timer: ${removed.error}`); return 1; }
    cloud.removeApproval(target, deps.homeDir);
    console.log(`  scheduled reviews ${removed.removed === false ? 'were not on' : 'are off'} for ${tildePath(target)}`);
    return 0;
  }
  const space = require('../lib/worktree-space');
  if (!deps.atrisBin && (space.isAgentCopyPath(atrisBin) || space.isScratchPath(atrisBin))) {
    console.error(`  refusing: this atris runs from ${path.dirname(path.dirname(atrisBin))}, a folder that gets removed. install the timer from a lasting atris install`);
    return 2;
  }

  // The engine is decided now, with the owner here, and written down. A
  // scheduled run never picks again.
  const token = deps.token !== undefined ? deps.token : cloud.authToken();
  let engines;
  try { engines = cloud.resolveEngines({ engine, token, env: deps.env || process.env }); } catch (e) { console.error(`  ${e.message}`); return 2; }
  let approval;
  if (engines.mode === 'atris') {
    let quote;
    try { quote = await quoteQuickRun(target, { hunter: engines.hunter, verifier: engines.verifier, token, cloud }); } catch (e) { console.error(`  no timer was set. ${e.message}`); return 2; }
    const cap = maxCredits || quote.credits;
    console.log(`\n  each scheduled review runs on atris models (no Claude Code or Codex needed)`);
    console.log(`  ${cloud.describeQuote(quote)}`);
    console.log(`  each run may spend at most ${cap} credits, once a ${every}. a run that reaches that stops\n`);
    if (!yes) {
      const input = deps.input || process.stdin;
      if (!input.isTTY && !deps.input) { console.error('  no timer was set. add --yes to approve this spend without the question'); return 1; }
      const ok = await (deps.ask || askYesNo)(`  approve up to ${cap} credits per scheduled run? (y/N) `, { input, output: process.stdout });
      if (!ok) { console.log('  no timer was set'); return 1; }
    }
    approval = { engine: 'atris', hunter: engines.hunter, verifier: engines.verifier, max_credits: cap, quoted_credits: quote.credits, every, approved_at: new Date().toISOString() };
  } else {
    approval = { engine: 'local', every, approved_at: new Date().toISOString() };
  }
  // Timed runs have no one to ask, so the answer is asked for now. With no
  // terminal and no saved answer it stays open (null): each run then saves
  // only if ATRIS_SENTINEL_UPLOAD or a later saved answer says yes.
  const consent = await uploadConsent(uploadFlag, { token, deps, tell: (m) => console.log(m) });
  approval.upload = consent.why === 'no-terminal' || consent.why === 'not-logged-in' ? null : consent.upload;
  cloud.writeApproval(target, approval, deps.homeDir);
  const installed = installKeep(plan, keepDeps);
  if (!installed.ok) { cloud.removeApproval(target, deps.homeDir); console.error(`  could not install the timer: ${installed.error}`); return 1; }
  console.log(`  scheduled reviews are on for ${tildePath(target)}, once a ${every}`);
  console.log(approval.upload
    ? '  each run uses the quick profile and saves its summary to your atris account'
    : '  each run uses the quick profile and keeps its results on this machine');
  console.log('  each run also checks your agent setup and dependencies for free');
  if (approval.engine === 'local') console.log('  runs use only Claude Code or Codex on this computer. they never switch to atris models');
  else console.log(`  runs use atris models and stop at ${approval.max_credits} credits`);
  console.log(`  log: ${tildePath(plan.log_path)}`);
  console.log(`  stop with: atris sentinel schedule --uninstall ${tildePath(target)}`);
  return 0;
}

// The quote-and-confirm step every run on atris models goes through: price
// the estimate and set the cap. Then a yes, --yes or a scheduled approval.
function spendConfirmer({ cloud, token, spend, capOverride, opts, deps, tell }) {
  return async (estimate) => {
    const quote = await cloud.quoteEstimate(estimate, { token });
    spend.max = capOverride || quote.credits;
    spend.limits = quote.limits;
    tell(`\n  ${cloud.describeQuote(quote)}\n`);
    if (capOverride) tell(`  this scheduled run may spend at most ${capOverride} credits, as approved`);
    if (opts.yes) return true;
    const input = deps.input || process.stdin;
    if (!input.isTTY && !deps.input) { console.error('  nothing was spent. add --yes to run without this question'); return false; }
    const yes = await (deps.ask || askYesNo)('  spend these credits? (y/N) ', { input, output: opts.json ? process.stderr : process.stdout });
    if (!yes) tell('  nothing was spent');
    return yes;
  };
}

function parseRecheckArgs(argv) {
  const opts = { json: false, verifier: null, engine: null, yes: false, upload: null, timeoutMs: null, budget: null, target: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const [flag, inline] = arg.startsWith('--') && arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, null];
    const value = () => {
      if (inline !== null) return inline;
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`${flag} needs a value`);
      return argv[++i];
    };
    if (flag === '--json') opts.json = true;
    else if (flag === '--verifier') opts.verifier = value();
    else if (flag === '--engine') opts.engine = value();
    else if (flag === '--yes' || flag === '-y') opts.yes = true;
    else if (flag === '--no-upload') opts.upload = false;
    else if (flag === '--upload') opts.upload = true;
    else if (flag === '--timeout') opts.timeoutMs = Number(value()) * 1000;
    else if (flag === '--budget') opts.budget = Number(value());
    else if (arg.startsWith('-')) throw new Error(`unknown flag: ${arg}`);
    else if (opts.target) throw new Error('give one folder to re-check');
    else opts.target = arg;
  }
  if (opts.engine !== null && !['atris', 'local'].includes(opts.engine)) throw new Error('--engine must be atris or local');
  if (opts.budget !== null && (!Number.isInteger(opts.budget) || opts.budget < 1 || opts.budget > 500)) throw new Error('--budget must be a whole number from 1 to 500');
  if (opts.timeoutMs !== null && (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs < 10000)) throw new Error('--timeout is in seconds, at least 10');
  return opts;
}

const OUTCOME_WORDS = { fixed: 'fixed', open: 'still open', moved: 'still open, moved', unsure: 'unsure, kept open', held: 'kept open' };

function renderRecheckLanding(result) {
  const { meta, records, dir } = result;
  if (require('../lib/security-audit').sourceWarning(meta)) return renderAuditLanding(result);
  const a = meta.audit;
  const byFp = new Map(records.map((r) => [r.fingerprint, r]));
  const L = ['', `  ◉ sentinel re-check · ${meta.repo}`, ''];
  L.push(`  re-checked ${a.checked} open finding${a.checked === 1 ? '' : 's'} from ${path.basename(meta.prior_run)}`);
  L.push(`  ${a.fixed} fixed · ${a.open} still open · ${a.unchanged} unchanged with no call`);
  for (const n of a.notes) {
    const r = byFp.get(n.fingerprint);
    const held = (a.held || []).find((h) => h.fingerprint === n.fingerprint);
    const title = r ? r.title : held ? held.title : n.fingerprint;
    const sev = r && r.severity ? r.severity.overall : held ? held.severity : '';
    L.push(`    ${(OUTCOME_WORDS[n.outcome] || n.outcome).padEnd(18)} ${sev ? `${sev} ` : ''}${title}`);
    L.push(`    ${''.padEnd(18)} ${n.why}`);
  }
  L.push(`  checked by ${meta.engines.verifier} · ${meta.invocations.used} engine call${meta.invocations.used === 1 ? '' : 's'}${meta.credits_used ? ` · ${meta.credits_used} credits used` : ''}`);
  if (meta.run_status === 'incomplete') L.push('  some findings got no answer. they stay open and wait for the next run');
  L.push(`  report: ${tildePath(path.join(dir, 'REPORT.md'))}`, '');
  return L.join('\n');
}

// Said when this folder's newest review read several places together.
function systemReviewNote(last, what) {
  return `  this folder was the ${last.system.part} part of a review of ${last.system.parts.length} places. ${what}`;
}

// atris sentinel recheck [path]: only the auditor, on the last review's open
// findings. Same engine rules, same price question and cap on atris models,
// same plain-sentence upload.
async function auditRecheckCommand(argv, deps = {}) {
  const audit = require('../lib/security-audit');
  const cloud = deps.cloud || require('../lib/sentinel-cloud');
  let opts;
  try { opts = parseRecheckArgs(argv); } catch (e) { console.error(`sentinel recheck: ${e.message}`); return 2; }
  const root = path.resolve(opts.target || deps.root || process.cwd());
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) { console.error(`sentinel recheck: ${root} is not a folder`); return 2; }
  // A newer review of several places is found and named, never skipped for
  // an older review of this folder alone.
  const newest = audit.latestReview(root);
  if (newest && newest.system) {
    const names = newest.system.parts.map((p) => p.name);
    const again = require('../lib/sentinel-places').rerunLine(newest.system.parts, newest.system.part, root);
    const nothing = `the last review of this folder read ${names.length} places together (${names.join(', ')}). recheck works on a review of one folder for now. to check those findings again, run that review again: ${again}`;
    if (opts.json) console.log(JSON.stringify({ ok: true, nothing, dir: newest.dir, system: newest.system }, null, 2));
    else console.log(`\n  ${nothing}\n`);
    return 0;
  }
  const token = deps.token !== undefined ? deps.token : cloud.authToken();
  let engines;
  try { engines = cloud.resolveEngines({ engine: opts.engine, verifier: opts.verifier, token, env: deps.env || process.env }); } catch (e) { console.error(`sentinel recheck: ${e.message}`); return 2; }
  let verifier = engines.verifier || undefined;
  const hosted = audit.isHostedEngine(verifier);
  if (hosted && !token) { console.error('sentinel recheck: re-checks on atris models need a login; run atris login first'); return 2; }
  const tell = opts.json ? (m) => console.error(m) : (m) => console.log(m);
  if (!deps.runJobs) {
    const pre = enginePreflight(engines, { roles: { verifier: verifier || 'claude' }, token, env: deps.env || process.env, signedIn: deps.signedIn });
    if (pre.stop) { console.error(pre.stop); return 2; }
    if (pre.roles) verifier = pre.roles.verifier;
    if (pre.note) tell(pre.note);
  }
  if (hosted && engines.chosen === 'no_local_engine') tell('  no Claude Code or Codex found on this computer. this re-check runs on atris models');
  const { upload } = await uploadConsent(opts.upload, { token, deps, tell, json: opts.json });
  const spend = hosted ? cloud.spendGuard({ quoteCall: deps.quoteCall }) : null;
  let runJobs = deps.runJobs;
  if (!runJobs && hosted) runJobs = cloud.atrisJobRunner({ token, spend });
  const confirmSpend = hosted ? spendConfirmer({ cloud, token, spend, capOverride: null, opts, deps, tell }) : null;
  let result;
  try {
    result = await audit.runRecheck({ root, verifier, runJobs, confirmSpend, budget: opts.budget ?? undefined, timeoutMs: opts.timeoutMs || undefined, log: opts.json ? () => {} : (m) => console.log(`  · ${m}`) });
  } catch (e) {
    console.error(`sentinel recheck: ${e.message}`);
    return 2;
  }
  if (result.nothing) {
    if (opts.json) console.log(JSON.stringify({ ok: true, nothing: result.nothing }, null, 2));
    else console.log(`\n  ${result.nothing}. nothing to do\n`);
    return 0;
  }
  if (result.declined) return 1;
  const fail = audit.shouldFailRun(result.dir, result.records);
  if (opts.json) console.log(JSON.stringify({ ok: !fail, dir: result.dir, meta: result.meta, findings: result.records }, null, 2));
  else console.log(renderRecheckLanding(result));
  addRunToRecord(root, result.dir, tell, deps);
  if (spend && spend.blocked) tell(`  stopped at the approved limit of ${spend.max} credits. ${spend.blocked} model call${spend.blocked === 1 ? '' : 's'} did not run. those findings stay open`);
  if (upload && token) {
    try { await uploadAfterRun(result.dir, { token, quiet: opts.json, cloud, root, env: deps.env || process.env }); } catch (e) { tell(`  warning: could not save the summary to your atris account: ${e.message}. the re-check itself is done`); }
  }
  return fail ? 1 : 0;
}

// Every finished review and recheck adds a signed entry to the security
// record. A failure warns and never changes the exit code.
function addRunToRecord(root, dir, tell, deps = {}) {
  const rec = require('../lib/sentinel-record');
  let res;
  try { res = rec.appendSafe(root, rec.entryFromRun(dir), { recordHome: deps.recordHome, homeDir: deps.homeDir, env: deps.env }); } catch (e) { res = { ok: false, reason: e.message }; }
  const w = rec.warnLine(res);
  if (w) tell(w);
  return res;
}

// Scope paths in a system review start with a part name (api/src). A path
// without one belongs to the current folder's part, when it is one.
function systemScope(places, system, cwd) {
  const names = new Set(system.parts.map((p) => p.name));
  const home = places.places[0] && places.places[0].home ? system.parts[0].name : null;
  return places.scope.map((word) => {
    const clean = String(word).replace(/\\/g, '/').replace(/^\.\/+/, '');
    if (names.has(clean.split('/')[0])) return clean;
    if (!home) throw new Error(`start ${word} with the name of its part (${[...names].join(', ')}), like ${[...names][0]}/src`);
    const rel = path.relative(cwd, path.resolve(cwd, word)).split(path.sep).join('/');
    if (!rel || rel.startsWith('..')) throw new Error(`${word} is not inside this folder`);
    return `${home}/${rel}`;
  });
}

// The review folder always goes. Clones go too unless --keep-clones.
function finishSystem(system, tell) {
  let kept = [];
  try { ({ kept } = system.cleanup()); } catch (e) { tell(`  warning: could not remove the temporary review copy: ${e.message}`); }
  for (const dir of kept) tell(`  kept the clone at ${tildePath(dir)}. delete it when you are done`);
}

async function auditCommand(argv, deps = {}) {
  // These subcommands answer their own --help (atris sentinel fix --help).
  // The others get the list of every command, never a run.
  const OWN_HELP = ['guard', 'bench', 'improve', 'fix', 'record'];
  const SUBCOMMANDS = [...OWN_HELP, 'status', 'last', 'agents', 'watch', 'flush', 'upload', 'recheck', 'schedule'];
  const helpFlag = argv.includes('-h') || argv.includes('--help');
  if (helpFlag && SUBCOMMANDS.includes(argv[0]) && !OWN_HELP.includes(argv[0])) return printAuditHelpAll();
  const wantsHelp = argv[0] === 'help' || (helpFlag && !OWN_HELP.includes(argv[0]));
  if (wantsHelp && (argv[1] === 'all' || argv.includes('--all'))) return printAuditHelpAll();
  if (wantsHelp) return printAuditHelp();
  const audit = require('../lib/security-audit');
  const root = deps.root || process.cwd();
  require('../lib/sentinel-cloud').keepProjectClean(root);
  if (argv[0] === 'status' || argv[0] === 'last') {
    // The newest review of this folder, alone or as one of several places.
    const last = audit.latestReview(root);
    if (!last || !last.meta) { console.log('\n  no finished sentinel review of this folder yet\n'); return 0; }
    const status = audit.sourceWarning(last.meta) ? 1 : 0;
    if (argv.includes('--json')) {
      const meta = status && last.meta.run_status === 'complete'
        ? { ...last.meta, run_status: 'incomplete', incomplete_reason: 'source_unverified' } : last.meta;
      console.log(JSON.stringify({ dir: last.dir, meta, findings: last.records, system: last.system || null, skipped: (last.skipped || []).map((s) => ({ run: path.basename(s.dir), why: s.why })) }, null, 2));
      return status;
    }
    const unfinished = (last.skipped || []).filter((s) => s.why === 'unfinished').length;
    if (unfinished) console.log(`\n  the newest review${unfinished === 1 ? '' : 's'} of this folder did not finish, so ${unfinished === 1 ? 'it changes' : 'they change'} nothing. this is the last one that did:`);
    console.log(renderAuditLanding({ dir: last.dir, meta: last.meta, records: last.records }));
    if (last.system) console.log(`${systemReviewNote(last, 'status shows it here. recheck and fix work on a review of one folder for now')}\n`);
    return status;
  }
  if (['agents', 'guard', 'watch', 'flush'].includes(argv[0])) {
    const powers = require('./sentinel-powers');
    const run = { agents: powers.agentsCommand, guard: powers.guardCommand, watch: powers.watchCommand, flush: powers.flushCommand }[argv[0]];
    return run(argv.slice(1), deps);
  }
  if (argv[0] === 'bench' || argv[0] === 'improve') {
    const sb = require('./sentinel-bench');
    return (argv[0] === 'bench' ? sb.benchCommand : sb.improveCommand)(argv.slice(1), deps);
  }
  if (argv[0] === 'fix') return require('./sentinel-fix').fixCommand(argv.slice(1), deps);
  if (argv[0] === 'record') return require('./sentinel-record').recordCommand(argv.slice(1), deps);
  if (argv[0] === 'upload') return auditUploadCommand(argv.slice(1), deps);
  if (argv[0] === 'recheck') return auditRecheckCommand(argv.slice(1), deps);
  if (argv[0] === 'schedule') return auditScheduleCommand(argv.slice(1), deps);
  let opts;
  try { opts = parseAuditArgs(argv); } catch (e) { console.error(`security-review audit: ${e.message}`); return 2; }
  let places;
  try {
    places = require('../lib/sentinel-places').resolvePlaces(root, opts.scope, opts.with);
    if ((opts.ref || opts.keepClones) && !places.places.some((p) => p.kind === 'url')) throw new Error(`${opts.ref ? '--ref' : '--keep-clones'} only applies to a git URL place`);
    if (places.multi && opts.scheduled) throw new Error('a timed review covers one folder; run reviews of several places by hand');
  } catch (e) { console.error(`security-review audit: ${e.message}`); return 2; }
  // A word that is no file or folder here (a typo, or a command that does
  // not exist) is never read as an empty part of the project to review.
  if (!places.multi) {
    const missing = places.scope.find((w) => !fs.existsSync(path.resolve(root, w)));
    if (missing !== undefined) {
      console.error(`\n  nothing was reviewed: there is no file or folder called ${missing} here, and it is not a sentinel command.\n  every command: atris sentinel help all\n`);
      return 2;
    }
  }
  const cloud = deps.cloud || require('../lib/sentinel-cloud');
  // A timer run does only what the owner approved at install.
  let capOverride = null;
  if (opts.scheduled) {
    const approval = cloud.readApproval(root, deps.homeDir);
    if (!approval) { console.error('security-review audit: this folder has no approved schedule. nothing ran. run atris sentinel schedule again'); return 2; }
    // The free checks run first, so a review that stops at its credit limit
    // still leaves today's agent and dependency results.
    try {
      await require('./sentinel-powers').runScheduledFreeChecks(root, { ...deps, upload: scheduledUpload(opts.upload, approval, deps), log: opts.json ? (m) => console.error(m) : (m) => console.log(m) });
    } catch (e) { console.error(`  warning: the free checks did not finish: ${e.message}`); }
    opts.hunter = null;
    opts.verifier = null;
    opts.engine = approval.engine;
    if (approval.engine === 'atris') { opts.yes = true; capOverride = Number(approval.max_credits); }
    // The timer's own answer, given when it was set up. Timers set before
    // the question existed told the person at setup that each run saves its
    // summary, so they keep saving.
    if (opts.upload === null && typeof approval.upload === 'boolean') opts.upload = approval.upload;
    else if (opts.upload === null && !('upload' in approval)) opts.upload = true;
  }
  const token = deps.token !== undefined ? deps.token : cloud.authToken();
  let engines;
  try { engines = cloud.resolveEngines({ engine: opts.engine, hunter: opts.hunter, verifier: opts.verifier, token, env: deps.env || process.env }); } catch (e) { console.error(`security-review audit: ${e.message}`); return 2; }
  let hunter = engines.hunter || undefined;
  let verifier = engines.verifier || undefined;
  const hosted = audit.isHostedEngine(hunter) || audit.isHostedEngine(verifier);
  if (hosted && !token) { console.error('security-review audit: reviews on atris models need a login; run atris login first'); return 2; }
  const tell = opts.json ? (m) => console.error(m) : (m) => console.log(m);
  if (!deps.runJobs && !opts.planOnly) {
    const pre = enginePreflight(engines, { roles: { hunter: hunter || 'codex', verifier: verifier || 'claude' }, token, env: deps.env || process.env, signedIn: deps.signedIn });
    if (pre.stop) { console.error(pre.stop); return 2; }
    if (pre.roles) ({ hunter, verifier } = pre.roles);
    if (pre.note) tell(pre.note);
  }
  const progress = opts.json || deps.quiet ? null : reviewProgress({ say: (m) => console.log(m), planOnly: opts.planOnly });
  const log = progress ? progress.log : () => {};
  if (hosted && engines.chosen === 'no_local_engine' && !opts.planOnly) tell('  no Claude Code or Codex found on this computer. this review runs on atris models');
  if (engines.chosen === 'only_one_local' && !opts.planOnly) tell(`  only ${engines.only} is installed, so ${engines.only} both looks for problems and double-checks them, in separate sessions`);
  if (hosted && !opts.planOnly) tell('  your code will be read on atris servers, not on this computer. lines that look like secrets are hidden before anything is sent');
  const { upload } = opts.planOnly ? { upload: false } : await uploadConsent(opts.upload, { token, deps, tell, json: opts.json });
  let runJobs = deps.runJobs;
  const spend = hosted ? cloud.spendGuard({ quoteCall: deps.quoteCall }) : null;
  if (!runJobs && hosted) runJobs = cloud.atrisJobRunner({ token, spend });
  const confirmSpend = spendConfirmer({ cloud, token, spend, capOverride, opts, deps, tell });
  // Several places (folders or git URLs) become one review folder. One
  // place keeps the one-folder review exactly as it was.
  let system = null;
  let runRoot = root;
  let scope = opts.scope;
  let stopped = null;
  if (places.multi) {
    if (opts.out) {
      const out = path.resolve(root, opts.out);
      const hit = places.places.find((p) => p.kind === 'path' && !path.relative(p.path, out).startsWith('..') && !path.isAbsolute(path.relative(p.path, out)));
      if (hit) { console.error(`security-review audit: --out ${opts.out} is inside ${hit.path}; pick a folder outside the places you review`); return 2; }
    }
    try {
      system = require('../lib/sentinel-places').buildSystem(places, { ref: opts.ref, keepClones: opts.keepClones, spawn: deps.spawn, tmpBase: deps.tmpBase, env: deps.env || process.env, log });
      runRoot = system.root;
      scope = system.multi ? systemScope(places, system, root) : places.scope;
    } catch (e) {
      if (system) finishSystem(system, tell);
      console.error(`security-review audit: ${e.message}`);
      return 2;
    }
    // Ctrl-C mid-review still removes the clones and the review copy.
    stopped = (sig) => { finishSystem(system, tell); process.exit(sig === 'SIGINT' ? 130 : 143); };
    process.once('SIGINT', stopped);
    process.once('SIGTERM', stopped);
  }
  let result;
  try {
    result = await audit.runAudit({
      root: runRoot, profile: opts.profile, scope, budget: opts.budget ?? undefined, out: opts.out,
      hunter, verifier, planOnly: opts.planOnly, runJobs, confirmSpend,
      timeoutMs: opts.timeoutMs || undefined, log,
    });
  } catch (e) {
    console.error(`security-review audit: ${e.message}`);
    return 2;
  } finally {
    if (progress) progress.stop();
    if (stopped) { process.removeListener('SIGINT', stopped); process.removeListener('SIGTERM', stopped); }
    if (system) finishSystem(system, tell);
  }
  if (result.declined) return 1;
  if (result.nothing_to_read) {
    const where = places.multi
      ? (scope.length ? scope.join(', ') : places.places.map((p) => (p.path ? tildePath(p.path) : p.url)).join(', '))
      : tildePath(scope.length ? scope.map((s) => path.join(root, s)).join(', ') : root);
    if (opts.json) console.log(JSON.stringify({ ok: false, nothing_reviewed: true, reason: result.nothing_to_read.readable_files ? 'no_place_to_check' : 'no_readable_code', readable_files: result.nothing_to_read.readable_files, dir: null }, null, 2));
    else console.log(nothingToReadText(result.nothing_to_read, where));
    return 2;
  }
  const nothingRead = !opts.planOnly && readNothing(result.meta);
  const fail = !opts.planOnly && (audit.shouldFailRun(result.dir, result.records) || nothingRead);
  if (opts.json) console.log(JSON.stringify({ ok: !fail, dir: result.dir, meta: result.meta, findings: result.records }, null, 2));
  else console.log(renderAuditLanding(result));
  if (!opts.planOnly) addRunToRecord(root, result.dir, tell, deps);
  if (spend && spend.blocked) tell(`  stopped at the approved limit of ${spend.max} credits. ${spend.blocked} model call${spend.blocked === 1 ? '' : 's'} did not run and wait for the next run`);
  if (upload && token && !opts.planOnly) {
    try { await uploadAfterRun(result.dir, { token, quiet: opts.json, cloud, root, env: deps.env || process.env }); } catch (e) { tell(`  warning: could not save the summary to your atris account: ${e.message}. the review itself is done`); }
  }
  return fail ? 1 : 0;
}

// The first screen a newcomer sees: the one path from install to a fix.
function printAuditHelp() {
  console.log(`
  atris sentinel looks for ways a stranger could break into your app.
  it explains each problem in plain words and can write the fix.

    atris sentinel              review the project in this folder
    atris sentinel --quick      a smaller, faster review
    atris sentinel src/         review only this folder
    atris sentinel status       show the last review again
    atris sentinel fix          list the problems it can fix
    atris sentinel fix <id>     write a fix and a test on a new branch

  you need Claude Code or Codex installed and signed in.
  they read your code on this computer. atris does not see it.
  no AI tool? atris login, then atris sentinel --engine atris
  (that costs credits, shows the price first and your code is read on
  atris servers, with lines that look like secrets hidden)

  it only reads. nothing in your project changes.
  a fix goes on its own branch. you look at it and merge it, or not.

  a review finds likely holes. it cannot prove there are none.

  every command: atris sentinel help all
`);
  return 0;
}

function printAuditHelpAll() {
  console.log(`
  atris sentinel, every command

    atris sentinel                              standard review of this folder
    atris sentinel src/                         review only these paths
    atris sentinel --quick                      one round, bigger parts, cheaper
    atris sentinel --deep                       more rounds, smaller parts
    atris sentinel --plan                       show what it would read, call no AI tool
    atris sentinel --budget 30                  most AI tool calls this review may use
    atris sentinel --hunter codex --verifier claude
                                                which tool looks and which double-checks
    atris sentinel --out DIR                    write the review here (outside the repo)
    atris sentinel status                       show the last review again

  several places as one system (a website, a server and a phone app that
  live in separate repos):

    atris sentinel ../web ../mobile             this repo plus two folders next to it
    atris sentinel --with git@github.com:acme/api.git
                                                add a repo from any git host
    atris sentinel --with https://gitlab.example.com/acme/web.git --ref main
                                                a branch or tag of the repo
    atris sentinel web api mobile               from a parent folder: just these three
    atris sentinel ../web --plan                show the parts and the budget, call no engine

  each place becomes a part named after its folder or repo, and every path in
  the report starts with that name, so two parts can both have src/index.js.
  the engines are told the parts are one system and follow requests across
  them: a page calling a server route, a webhook sender and its receiver. one
  budget covers all the parts; it is never multiplied.

  a git URL is cloned with your own git login into a fresh temporary folder:
  newest commit only, no hooks, no submodules, no large files, and nothing in
  it ever runs. the clone is deleted when the review ends, even when it fails.
  add --keep-clones to keep it. only tracked files of each part are reviewed.
  to narrow a several-place review, start the path with its part: api/src.

  on atris models (no other AI subscription needed, paid in atris credits):

    atris sentinel --engine atris               atris:fast searches, atris:pro checks
    atris sentinel --engine atris --yes         skip the price question
    atris sentinel --engine local               only Claude Code or Codex on this computer

  with no --engine, it uses Claude Code or Codex when one is installed.
  atris models run only when neither is installed and you are logged in.
  every run on atris models shows the most it can cost first and stops
  before it could pass that. lines that look like secrets are hidden and
  only tracked files inside the review are ever sent.

  saving results to your atris account (asked once, off until you say yes):

    atris sentinel --upload                     save this run's summary
    atris sentinel --no-upload                  keep this run on this machine only
    atris sentinel upload --always              save every run from now on (--never to stop)
    atris sentinel upload [run-folder]          save a past run (default: the last one)
    ATRIS_SENTINEL_UPLOAD=1                     say yes in CI and scripts, where nothing is asked

  re-checking old findings (every review does this first):

    atris sentinel recheck [path]               only re-check the last review's open findings
    atris sentinel recheck --engine atris       re-check on atris models, price shown first

  a finding whose code did not change stays open without a call. a changed
  one goes to the verifier, never the engine that found it. it is marked
  fixed only with a yes and the line that now closes it. unsure stays open.

  only the summary is saved: plain sentences, file:line locations and counts.
  source code and code lines never leave in an upload.

  free checks, no model and no credits:

    atris sentinel agents [path]                check agent instructions, settings, hooks, mcp and skills
    atris sentinel agents --home                also check ~/.claude and ~/.codex
    atris sentinel watch [path]                 known attacks in your dependencies (osv database)
    atris sentinel watch --fix                  update affected packages on a new branch, never pushed
    atris sentinel watch --fix --allow-major    also take fixes that jump to a new major version
    atris sentinel guard install [--global]     stop risky agent commands before they run
    atris sentinel guard test                   see which sample commands the guard stops

  results go to your atris dashboard only after you said yes (see above).
  secret values and file contents never leave.

  watch exits with 3 when the osv database did not answer, so nothing was
  checked. watch --fix moves a package only to a version osv shows clean.
  it runs npm and pnpm with project scripts off and leaves a yarn project
  that sets yarnPath or plugins to you. poetry and bundler still read the
  project's own pyproject.toml and Gemfile, so use --fix there only on code
  you trust.

  the exam and the loop that improves the sentinel (in an atris checkout):

    atris sentinel bench [--summary]            score the guard and agent check on a seen and a held-out half
    atris sentinel improve [--engine claude]    one engine proposes a change, the exam decides if it stays
    atris sentinel improve --schedule           run the improve loop nightly

  the signed security record (hand it to a customer's security reviewer):

    atris sentinel record [path]                what was checked, what is open and fixed, how long fixes took
    atris sentinel record key                   the public key and fingerprint reviewers compare against
    atris sentinel record export --out record.html
                                                one file that checks its own signatures in the browser
    atris sentinel record verify FILE           check an exported record offline
    atris sentinel record backfill              add past reviews, marked as added later

  turning a confirmed finding into a fix:

    atris sentinel fix                          list confirmed findings you can fix
    atris sentinel fix <id> [path]              smallest fix plus a regression test on a new branch
    atris sentinel fix help                     how a fix is proved before it is committed

  reviews on a timer:

    atris sentinel schedule --every day [path]  quick review once a day, saved to your account
    atris sentinel schedule --every week [path] once a week
    atris sentinel schedule --engine atris --max-credits 20
                                                timed runs on atris models, at most 20 credits each
    atris sentinel schedule --uninstall [path]  stop the timer

  every timed run also runs the free agents and watch checks.
  the engine is picked when the timer goes on. on atris models you see the
  price and say yes then. a timed run never switches to atris models later.

  how it works: your code is split into parts, one for each file and kind of
  attack worth checking. one AI tool reads each part, only reading, never
  running your code. every possible problem it finds goes to a second tool
  (or a fresh session of the same one) that tries to prove it wrong. the lines
  it points to must exist. reviews add up: unchanged parts are skipped next time.

  the report: ~/.atris/security-audit/<project>/run-<N>/REPORT.md, with the
  detail beside it. nothing is written inside your project. the command exits
  with 1 when a double-checked problem is high or critical, so CI can stop on it.
`);
  return 0;
}

function printHelp() {
  console.log(`
  atris security-review, deterministic secrets / PII / privacy scan (no LLM)

    atris security-review            scan git-tracked files (default)
    atris security-review <path>     scan a file or dir
    atris security-review --staged   scan staged changes (pre-commit gate)
    atris security-review --strict   also fail on MEDIUM (PII / personal paths)
    atris security-review --json     machine output / SOC 2 evidence artifact
    atris security-review --md       markdown evidence report
    atris security-review --deep     prompt a stronger model with framework + evidence
    atris security-review --land     the landing: cleared-to-ship or hold, what changed,
                                      what needs you, the trend (read this after the loop)
    atris security-review --update-baseline
                                      accept current findings in .security-review.baseline.json
    atris security-review --no-baseline
                                      ignore .security-review.baseline.json
    atris security-review rules       list the active detectors
    atris security-review hook        install a pre-commit gate
    atris security-review audit       sentinel audit: engines hunt, another model
                                      verifies (atris security-review audit help)

  Scans for real-looking secrets, API keys, personal data, tracked sensitive
  files, and code-exec review evidence. exit 0 = clean, 1 = found. Wire into
  the autopilot/mission gate and CI.
`);
  return 0;
}

module.exports = { securityReviewCommand, auditCommand, parseAuditArgs, enginePreflight, plainProgress, reviewProgress, renderAuditLanding, printAuditHelp };
