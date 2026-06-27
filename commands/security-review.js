// atris security-review — deterministic secrets / PII / privacy scan (no LLM).
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
      console.log(`\n  ✓ clean — no active secrets, PII, or sensitive files in ${raw.scanned} tracked file${raw.scanned === 1 ? '' : 's'}`);
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
// loop — the opposite of a finding dump.
function renderLanding(landing, threshold) {
  const date = new Date().toISOString().slice(0, 10);
  const L = ['', `  ✈ security landing — ${date}`, ''];
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
      L.push(`    ${f.sev.toUpperCase().padEnd(8)} ${f.file}${f.line ? ':' + f.line : ''} — ${f.why}`);
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
  console.log('\n  atris security-review — deterministic rules:\n');
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

function printHelp() {
  console.log(`
  atris security-review — deterministic secrets / PII / privacy scan (no LLM)

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

  Scans for real-looking secrets, API keys, personal data, tracked sensitive
  files, and code-exec review evidence. exit 0 = clean, 1 = found. Wire into
  the autopilot/mission gate and CI.
`);
  return 0;
}

module.exports = { securityReviewCommand };
