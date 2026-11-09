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
  const opts = { profile: 'standard', scope: [], json: false, planOnly: false, budget: null, out: null, hunter: null, verifier: null, timeoutMs: null, engine: null, yes: false, upload: true, scheduled: false };
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
    else if (flag === '--scheduled') opts.scheduled = true;
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
    const { hunters, hunters_needed: needed, units_per_hunter: per, verifyReserve } = meta.plan;
    const sending = Math.min(hunters, needed);
    L.push(`  a ${meta.profile} run with budget ${meta.budget} sends about ${sending} hunter${sending === 1 ? '' : 's'} (up to ${per} area${per === 1 ? '' : 's'} each) and keeps ${verifyReserve} checks for verifying`);
    if (hunters < 1) L.push('  this budget is too small to send a hunter; try --budget 8 or more');
    else L.push(needed <= hunters ? '  one run can read every area' : `  about ${Math.ceil(needed / hunters)} runs to read every area`);
  } else {
    L.push(`  ${confirmed.length} confirmed${sevText ? ` (${sevText})` : ''} · ${needs.length} need a fact from you · ${rejected.length} disproved`);
    L.push(`  read ${cov.fresh} areas this run, ${cov.carried} carried unchanged, ${cov.deferred || 0} left for the next run`);
    L.push(`  found by ${meta.engines.hunter}, checked by ${meta.engines.verifier}${meta.engines.hunter === meta.engines.verifier ? ' (same engine)' : ''} · ${meta.invocations.used} engine calls of ${meta.budget}${meta.credits_used ? ` · ${meta.credits_used} credits used` : ''}`);
    for (const r of confirmed.slice(0, 6)) {
      const sink = r.trace[r.trace.length - 1];
      L.push(`    ${r.severity.overall.padEnd(8)} ${r.title} (${sink.file}:${sink.line})`);
    }
    if (meta.run_status === 'incomplete') L.push(`  incomplete: ${String(meta.incomplete_reason).replace(/_/g, ' ')}`);
  }
  L.push(`  report: ${tildePath(path.join(dir, 'REPORT.md'))}`, '');
  return L.join('\n');
}

// Ask once on a terminal. Anything but y or yes is a no.
function askYesNo(question, { input = process.stdin, output = process.stdout } = {}) {
  return new Promise((resolve) => {
    const rl = require('readline').createInterface({ input, output });
    rl.question(question, (answer) => { rl.close(); resolve(/^\s*y(es)?\s*$/i.test(String(answer || ''))); });
  });
}

async function uploadAfterRun(dir, { token, quiet, cloud }) {
  const res = await cloud.uploadRun(dir, { token });
  const say = quiet ? (m) => console.error(m) : (m) => console.log(m);
  if (res.ok) say('  saved the summary to your atris account (no source code was sent)');
  else say(`  warning: could not save the summary to your atris account: ${res.reason}. the review itself is done`);
  return res;
}

async function auditUploadCommand(argv, deps) {
  const audit = require('../lib/security-audit');
  const cloud = deps.cloud || require('../lib/sentinel-cloud');
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
  const res = await cloud.uploadRun(dir, { token });
  if (!res.ok) { console.error(`  could not save ${path.basename(dir)}: ${res.reason}`); return 1; }
  console.log(`  saved ${path.basename(dir)} to your atris account (no source code was sent)`);
  return 0;
}

// Price one quick run on atris models for a folder without calling any
// model: the audit plans, the estimate is quoted, and the plan is dropped.
async function quoteQuickRun(target, { hunter, verifier, token, cloud }) {
  const audit = require('../lib/security-audit');
  let estimate = null;
  await audit.runAudit({
    root: target, profile: 'quick', hunter, verifier,
    runJobs: async () => { throw new Error('no model call while pricing a schedule'); },
    confirmSpend: async (est) => { estimate = est; return false; },
  });
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
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const [flag, inline] = a.startsWith('--') && a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, null];
    const value = () => (inline !== null ? inline : argv[++i]);
    if (flag === '--every') every = value();
    else if (flag === '--engine') engine = value();
    else if (flag === '--max-credits') maxCredits = Number(value());
    else if (flag === '--yes' || flag === '-y') yes = true;
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
    console.log(`\n  each scheduled review runs on atris models (no codex or claude needed)`);
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
  cloud.writeApproval(target, approval, deps.homeDir);
  const installed = installKeep(plan, keepDeps);
  if (!installed.ok) { cloud.removeApproval(target, deps.homeDir); console.error(`  could not install the timer: ${installed.error}`); return 1; }
  console.log(`  scheduled reviews are on for ${tildePath(target)}, once a ${every}`);
  console.log('  each run uses the quick profile and saves its summary to your atris account');
  console.log('  each run also checks your agent setup and dependencies for free');
  if (approval.engine === 'local') console.log('  runs use only codex and claude on this machine. they never switch to atris models');
  else console.log(`  runs use atris models and stop at ${approval.max_credits} credits`);
  console.log(`  log: ${tildePath(plan.log_path)}`);
  console.log(`  stop with: atris sentinel schedule --uninstall ${tildePath(target)}`);
  return 0;
}

async function auditCommand(argv, deps = {}) {
  if (argv[0] === 'help' || argv.includes('-h') || argv.includes('--help')) return printAuditHelp();
  const audit = require('../lib/security-audit');
  const root = deps.root || process.cwd();
  if (argv[0] === 'status' || argv[0] === 'last') {
    const last = audit.latestRun(root);
    if (!last || !last.meta) { console.log('\n  no sentinel audit has run for this repo yet\n'); return 0; }
    if (argv.includes('--json')) { console.log(JSON.stringify({ dir: last.dir, meta: last.meta, findings: last.records }, null, 2)); return 0; }
    console.log(renderAuditLanding({ dir: last.dir, meta: last.meta, records: last.records }));
    return 0;
  }
  if (['agents', 'guard', 'watch', 'flush'].includes(argv[0])) {
    const powers = require('./sentinel-powers');
    const run = { agents: powers.agentsCommand, guard: powers.guardCommand, watch: powers.watchCommand, flush: powers.flushCommand }[argv[0]];
    return run(argv.slice(1), deps);
  }
  if (argv[0] === 'upload') return auditUploadCommand(argv.slice(1), deps);
  if (argv[0] === 'schedule') return auditScheduleCommand(argv.slice(1), deps);
  let opts;
  try { opts = parseAuditArgs(argv); } catch (e) { console.error(`security-review audit: ${e.message}`); return 2; }
  const cloud = deps.cloud || require('../lib/sentinel-cloud');
  // A timer run does only what the owner approved at install.
  let capOverride = null;
  if (opts.scheduled) {
    const approval = cloud.readApproval(root, deps.homeDir);
    if (!approval) { console.error('security-review audit: this folder has no approved schedule. nothing ran. run atris sentinel schedule again'); return 2; }
    // The free checks run first, so a review that stops at its credit limit
    // still leaves today's agent and dependency results.
    try {
      await require('./sentinel-powers').runScheduledFreeChecks(root, { ...deps, upload: opts.upload, log: opts.json ? (m) => console.error(m) : (m) => console.log(m) });
    } catch (e) { console.error(`  warning: the free checks did not finish: ${e.message}`); }
    opts.hunter = null;
    opts.verifier = null;
    opts.engine = approval.engine;
    if (approval.engine === 'atris') { opts.yes = true; capOverride = Number(approval.max_credits); }
  }
  const token = deps.token !== undefined ? deps.token : cloud.authToken();
  let engines;
  try { engines = cloud.resolveEngines({ engine: opts.engine, hunter: opts.hunter, verifier: opts.verifier, token, env: deps.env || process.env }); } catch (e) { console.error(`security-review audit: ${e.message}`); return 2; }
  const hunter = engines.hunter || undefined;
  const verifier = engines.verifier || undefined;
  const hosted = audit.isHostedEngine(hunter) || audit.isHostedEngine(verifier);
  if (hosted && !token) { console.error('security-review audit: reviews on atris models need a login; run atris login first'); return 2; }
  const log = opts.json ? () => {} : (msg) => console.log(`  · ${msg}`);
  const tell = opts.json ? (m) => console.error(m) : (m) => console.log(m);
  if (hosted && engines.chosen === 'no_local_engine' && !opts.planOnly) tell('  no codex or claude found on this machine. this review runs on atris models');
  let runJobs = deps.runJobs;
  const spend = hosted ? cloud.spendGuard({ quoteCall: deps.quoteCall }) : null;
  if (!runJobs && hosted) runJobs = cloud.atrisJobRunner({ token, spend });
  const confirmSpend = async (estimate) => {
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
  let result;
  try {
    result = await audit.runAudit({
      root, profile: opts.profile, scope: opts.scope, budget: opts.budget ?? undefined, out: opts.out,
      hunter, verifier, planOnly: opts.planOnly, runJobs, confirmSpend,
      timeoutMs: opts.timeoutMs || undefined, log,
    });
  } catch (e) {
    console.error(`security-review audit: ${e.message}`);
    return 2;
  }
  if (result.declined) return 1;
  const fail = audit.shouldFailAudit(result.records);
  if (opts.json) console.log(JSON.stringify({ ok: !fail, dir: result.dir, meta: result.meta, findings: result.records }, null, 2));
  else console.log(renderAuditLanding(result));
  if (spend && spend.blocked) tell(`  stopped at the approved limit of ${spend.max} credits. ${spend.blocked} model call${spend.blocked === 1 ? '' : 's'} did not run and wait for the next run`);
  if (opts.upload && token && !opts.planOnly) {
    try { await uploadAfterRun(result.dir, { token, quiet: opts.json, cloud }); } catch (e) { tell(`  warning: could not save the summary to your atris account: ${e.message}. the review itself is done`); }
  }
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

  on atris models (no other AI subscription needed, paid in atris credits):

    atris sentinel --engine atris               atris:fast searches, atris:pro checks
    atris sentinel --engine atris --yes         skip the price question
    atris sentinel --engine local               only codex and claude on this machine

  with no --engine, local engines run when codex or claude is installed.
  atris models run only when neither is installed and you are logged in.
  every run on atris models shows the most it can cost first and stops
  before it could pass that. lines that look like secrets are hidden and
  only tracked files inside the review are ever sent.

  saving results to your atris account (on when you are logged in):

    atris sentinel --no-upload                  keep this run on this machine only
    atris sentinel upload [run-folder]          save a past run (default: the last one)

  only the summary is saved: plain sentences, file:line locations and counts.
  source code and code lines never leave in an upload.

  free checks, no model and no credits:

    atris sentinel agents [path]                check agent instructions, settings, hooks, mcp and skills
    atris sentinel agents --home                also check ~/.claude and ~/.codex
    atris sentinel watch [path]                 known attacks in your dependencies (osv database)
    atris sentinel watch --fix                  update affected packages on a new branch, never pushed
    atris sentinel guard install [--global]     stop risky agent commands before they run
    atris sentinel guard test                   see which sample commands the guard stops

  results go to your atris dashboard when you are logged in. add --no-upload
  to keep them on this machine. secret values and file contents never leave.

  reviews on a timer:

    atris sentinel schedule --every day [path]  quick review once a day, saved to your account
    atris sentinel schedule --every week [path] once a week
    atris sentinel schedule --engine atris --max-credits 20
                                                timed runs on atris models, at most 20 credits each
    atris sentinel schedule --uninstall [path]  stop the timer

  every timed run also runs the free agents and watch checks.
  the engine is picked when the timer goes on. on atris models you see the
  price and say yes then. a timed run never switches to atris models later.

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

module.exports = { securityReviewCommand, auditCommand };
