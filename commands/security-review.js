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
  if (sub === 'help' || argv.includes('-h') || argv.includes('--help')) return printHelp();
  if (sub === 'rules') return printRules();
  if (sub === 'hook' || sub === 'install-hook') return installHook();
  if (sub === 'audit') return auditCommand(argv.slice(1));

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
      console.log(`\n  ✓ clean, no active secrets, PII, or sensitive files in ${raw.scanned} tracked file${raw.scanned === 1 ? '' : 's'}`);
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
    L.push(`  CLEARED TO SHIP    no unresolved findings at the ${threshold.toUpperCase()} line`);
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
  const opts = { profile: 'standard', scope: [], json: false, planOnly: false, budget: null, out: null, hunter: null, verifier: null, timeoutMs: null };
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
    else if (arg.startsWith('-')) throw new Error(`unknown flag: ${arg}`);
    else opts.scope.push(arg);
  }
  const { PROFILES } = require('../lib/security-audit');
  if (!PROFILES.includes(opts.profile)) throw new Error(`--profile must be one of ${PROFILES.join(', ')}`);
  if (opts.budget !== null && (!Number.isInteger(opts.budget) || opts.budget < 1 || opts.budget > 500)) throw new Error('--budget must be a whole number from 1 to 500');
  if (opts.timeoutMs !== null && (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs < 10000)) throw new Error('--timeout is in seconds, at least 10');
  return opts;
}

function tildePath(p) {
  const home = require('os').homedir();
  return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

// The audit landing: what was found, how much was read, what is left.
function renderAuditLanding({ dir, meta, records }) {
  const confirmed = records.filter((r) => r.verdict === 'confirmed');
  const needs = records.filter((r) => r.verdict === 'needs_validation');
  const rejected = records.filter((r) => r.verdict === 'rejected');
  const sev = meta.counts.severity;
  const cov = meta.coverage;
  const sevText = ['critical', 'high', 'medium', 'low', 'informational'].filter((s) => sev[s]).map((s) => `${sev[s]} ${s}`).join(', ');
  const L = ['', `  ◉ sentinel security audit · ${meta.profile}${meta.scope_paths.length ? ` · ${meta.scope_paths.join(', ')}` : ''}`, ''];
  if (meta.incomplete_reason === 'plan_only') {
    L.push(`  plan only: ${cov.in_scope} areas to review, no engines called`);
    L.push(`  a ${meta.profile} run with budget ${meta.budget} sends ${meta.plan.hunters} hunters (${meta.plan.units_per_hunter} area${meta.plan.units_per_hunter === 1 ? '' : 's'} each) and keeps ${meta.plan.verifyReserve} checks for verifying`);
  } else {
    L.push(`  ${confirmed.length} confirmed${sevText ? ` (${sevText})` : ''} · ${needs.length} need a fact from you · ${rejected.length} disproved`);
    L.push(`  read ${cov.fresh} areas this run, ${cov.carried} carried unchanged, ${cov.deferred || 0} left for the next run`);
    L.push(`  found by ${meta.engines.hunter}, checked by ${meta.engines.verifier}${meta.engines.hunter === meta.engines.verifier ? ' (same engine)' : ''} · ${meta.invocations.used} engine calls of ${meta.budget}`);
    for (const r of confirmed.slice(0, 6)) {
      const sink = r.trace[r.trace.length - 1];
      L.push(`    ${r.severity.overall.padEnd(8)} ${r.title} (${sink.file}:${sink.line})`);
    }
    if (meta.run_status === 'incomplete') L.push(`  incomplete: ${String(meta.incomplete_reason).replace(/_/g, ' ')}`);
  }
  L.push(`  report: ${tildePath(path.join(dir, 'REPORT.md'))}`, '');
  return L.join('\n');
}

async function auditCommand(argv) {
  if (argv[0] === 'help' || argv.includes('-h') || argv.includes('--help')) return printAuditHelp();
  const audit = require('../lib/security-audit');
  if (argv[0] === 'status' || argv[0] === 'last') {
    const last = audit.latestRun(process.cwd());
    if (!last || !last.meta) { console.log('\n  no sentinel audit has run for this repo yet\n'); return 0; }
    if (argv.includes('--json')) { console.log(JSON.stringify({ dir: last.dir, meta: last.meta, findings: last.records }, null, 2)); return 0; }
    console.log(renderAuditLanding({ dir: last.dir, meta: last.meta, records: last.records }));
    return 0;
  }
  let opts;
  try { opts = parseAuditArgs(argv); } catch (e) { console.error(`security-review audit: ${e.message}`); return 2; }
  const log = opts.json ? () => {} : (msg) => console.log(`  · ${msg}`);
  let result;
  try {
    result = await audit.runAudit({
      root: process.cwd(), profile: opts.profile, scope: opts.scope, budget: opts.budget ?? undefined, out: opts.out,
      hunter: opts.hunter || undefined, verifier: opts.verifier || undefined, planOnly: opts.planOnly,
      timeoutMs: opts.timeoutMs || undefined, log,
    });
  } catch (e) {
    console.error(`security-review audit: ${e.message}`);
    return 2;
  }
  const fail = audit.shouldFailAudit(result.records);
  if (opts.json) console.log(JSON.stringify({ ok: !fail, dir: result.dir, meta: result.meta, findings: result.records }, null, 2));
  else console.log(renderAuditLanding(result));
  return fail ? 1 : 0;
}

function printAuditHelp() {
  console.log(`
  atris security-review audit, the sentinel's full security audit

    atris security-review audit                 standard audit of the repo
    atris security-review audit src/            audit only these paths
    atris security-review audit --quick         one wave, coarse areas, cheap
    atris security-review audit --deep          more waves, smaller areas
    atris security-review audit --plan          map areas and budget, call no engine
    atris security-review audit --budget 30     most engine calls this run may spend
    atris security-review audit --hunter codex --verifier claude
                                                which engines hunt and which verify
    atris security-review audit --out DIR       write the run here (outside the repo)
    atris security-review audit status          the last run's landing

  How it works: every source file x attack class with a reason to be read
  becomes an area in a coverage ledger. Read-only engine hunters each own a
  few areas. A coverage critic names gaps. Every candidate goes to a different
  model that tries to disprove it, and cited lines must exist before any spend.
  Runs add up: unchanged areas are skipped next time.

  Output: ~/.atris/security-audit/<repo>/run-<N>/ (REPORT.md,
  FINDINGS-DETAIL.md, NEEDS-VALIDATION.md, findings.json, coverage-ledger.json).
  Nothing is written inside the repo. Exit 1 when a confirmed finding is high
  or critical.
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

module.exports = { securityReviewCommand };
