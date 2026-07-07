'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const SCORECARD_SCHEMA = 'atris.experiment.daily.v1';
const BENCH_SCHEMA = 'atris.bench.run.v1';

function todayDate() {
  return new Date().toISOString().slice(0, 10);
}

function statePath(root) {
  return path.join(root, '.atris', 'state', 'experiments-daily.json');
}

function queuePath(root) {
  return path.join(root, 'atris', 'experiments', 'daily', 'queue.jsonl');
}

function resultsPath(root) {
  return path.join(root, 'atris', 'experiments', 'daily', 'results.tsv');
}

function scorecardsPath(root) {
  return path.join(root, '.atris', 'state', 'scorecards.jsonl');
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function readDailyState(root) {
  const state = readJson(statePath(root), {});
  if (!Array.isArray(state.history)) state.history = [];
  return state;
}

function writeDailyState(root, state) {
  writeJson(statePath(root), state);
}

function readQueue(root) {
  const file = queuePath(root);
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // skip malformed lines
    }
  }
  return out;
}

function appendQueueEntry(root, entry) {
  const file = queuePath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8');
}

function pickQueueEntry(root, history = []) {
  const seen = new Set(history);
  return readQueue(root).find((entry) => entry && entry.id && !seen.has(entry.id)) || null;
}

function parseCommaList(value) {
  return String(value || '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

function parseQueueAddArgs(args) {
  const options = {
    id: null,
    target: [],
    apply: null,
    verify: null,
    note: '',
  };

  if (args[0] && !args[0].startsWith('--')) {
    options.id = args.shift();
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--target' && args[i + 1]) {
      options.target = parseCommaList(args[++i]);
      continue;
    }
    if (arg.startsWith('--target=')) {
      options.target = parseCommaList(arg.slice('--target='.length));
      continue;
    }
    if (arg === '--apply' && args[i + 1]) {
      options.apply = args[++i];
      continue;
    }
    if (arg.startsWith('--apply=')) {
      options.apply = arg.slice('--apply='.length);
      continue;
    }
    if (arg === '--verify' && args[i + 1]) {
      options.verify = args[++i];
      continue;
    }
    if (arg.startsWith('--verify=')) {
      options.verify = arg.slice('--verify='.length);
      continue;
    }
    if (arg === '--note' && args[i + 1]) {
      options.note = args[++i];
      continue;
    }
    if (arg.startsWith('--note=')) {
      options.note = arg.slice('--note='.length);
      continue;
    }
  }

  return options;
}

function parseDailyArgs(args) {
  return {
    dryRun: args.includes('--dry-run'),
    force: args.includes('--force'),
    json: args.includes('--json'),
    keepIfAllPass: args.includes('--keep-if') && args[args.indexOf('--keep-if') + 1] === 'all-pass',
  };
}

function areTargetsClean(root, targetFiles) {
  for (const rel of targetFiles) {
    const result = spawnSync('git', ['status', '--porcelain', '--', rel], {
      cwd: root,
      encoding: 'utf8',
    });
    if (result.status !== 0) {
      return { clean: false, reason: `git status failed for ${rel}` };
    }
    if (String(result.stdout || '').trim()) {
      return { clean: false, reason: `target file not clean in git: ${rel}` };
    }
  }
  return { clean: true };
}

function defaultBenchArgv(root, label, experimentId) {
  const bin = path.join(root, 'bin', 'atris.js');
  const cliBin = fs.existsSync(bin) ? bin : path.resolve(__dirname, '..', '..', 'bin', 'atris.js');
  return {
    cmd: process.execPath,
    args: [cliBin, 'bench', 'run', '--label', label, '--experiment', experimentId, '--json'],
  };
}

function runBench(root, { label, experimentId, env = process.env }) {
  let cmd;
  let args;
  if (env.ATRIS_BENCH_CMD) {
    cmd = env.ATRIS_BENCH_CMD;
    args = ['--label', label, '--experiment', experimentId, '--json'];
  } else {
    ({ cmd, args } = defaultBenchArgv(root, label, experimentId));
  }

  const result = spawnSync(cmd, args, {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...env,
      ATRIS_SKIP_UPDATE_CHECK: '1',
    },
  });

  let parsed = null;
  const stdout = String(result.stdout || '').trim();
  if (stdout) {
    try {
      parsed = JSON.parse(stdout);
    } catch {
      parsed = null;
    }
  }

  const exitCode = typeof result.status === 'number' ? result.status : 2;
  return { exitCode, parsed, stdout, stderr: String(result.stderr || '') };
}

function benchInfraError(exitCode) {
  return exitCode === 2;
}

function parseBenchResult(parsed) {
  if (!parsed || parsed.schema !== BENCH_SCHEMA) {
    return {
      passed: [],
      failed: [],
      skipped: [],
      valid: false,
    };
  }
  return {
    passed: Array.isArray(parsed.passed) ? parsed.passed : [],
    failed: Array.isArray(parsed.failed) ? parsed.failed : [],
    skipped: Array.isArray(parsed.skipped) ? parsed.skipped : [],
    valid: true,
  };
}

function evaluateKeepRule({ baseline, candidate, verifyPassed, keepIfAllPass }) {
  const baselinePassed = new Set(baseline.passed || []);
  const candidatePassed = new Set(candidate.passed || []);
  const candidateFailed = new Set(candidate.failed || []);
  const skipped = new Set([...(baseline.skipped || []), ...(candidate.skipped || [])]);

  if (verifyPassed === false) return { keep: false, reason: 'verify_failed' };

  if (keepIfAllPass) {
    const allTaskIds = new Set([
      ...(baseline.passed || []),
      ...(baseline.failed || []),
      ...(candidate.passed || []),
      ...(candidate.failed || []),
    ]);
    for (const id of allTaskIds) {
      if (skipped.has(id)) continue;
      if (!candidatePassed.has(id) || candidateFailed.has(id)) {
        return { keep: false, reason: 'all_pass_required' };
      }
    }
    return { keep: true, reason: 'all_pass' };
  }

  for (const id of baselinePassed) {
    if (!candidatePassed.has(id)) {
      return { keep: false, reason: 'baseline_regression' };
    }
  }
  return { keep: true, reason: 'superset' };
}

function runApplyScript(root, applyPath) {
  const scriptPath = path.isAbsolute(applyPath) ? applyPath : path.join(root, applyPath);
  // .js apply scripts run on the node that runs the CLI: the sh-polyglot
  // header needs `node` on PATH, which overnight cron environments lack.
  const isJs = scriptPath.endsWith('.js') || scriptPath.endsWith('.cjs') || scriptPath.endsWith('.mjs');
  return spawnSync(isJs ? process.execPath : 'sh', [scriptPath], {
    cwd: root,
    encoding: 'utf8',
    env: process.env,
  });
}

function runVerifyCommand(root, command) {
  const { envWithNodeDir } = require('../spawn-env');
  return spawnSync(command, {
    cwd: root,
    encoding: 'utf8',
    shell: true,
    env: envWithNodeDir(process.env),
  });
}

function appendResultsTsv(root, row) {
  const file = resultsPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const header = 'timestamp\texperiment_id\tdecision\tbaseline_passed\tcandidate_passed\tverify_passed\tnote\n';
  if (!fs.existsSync(file) || fs.statSync(file).size === 0) {
    fs.writeFileSync(file, header, 'utf8');
  }
  const line = [
    row.timestamp,
    row.experiment_id,
    row.decision,
    row.baseline_passed,
    row.candidate_passed,
    row.verify_passed,
    row.note,
  ].join('\t');
  fs.appendFileSync(file, `${line}\n`, 'utf8');
}

function appendScorecardRow(root, row) {
  const file = scorecardsPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(row)}\n`, 'utf8');
  return file;
}

function buildScorecardRow(payload) {
  return {
    schema: SCORECARD_SCHEMA,
    ts: payload.ts || new Date().toISOString(),
    experiment_id: payload.experiment_id,
    decision: payload.decision,
    baseline_passed: payload.baseline_passed || [],
    candidate_passed: payload.candidate_passed || [],
    baseline_failed: payload.baseline_failed || [],
    candidate_failed: payload.candidate_failed || [],
    verify_passed: payload.verify_passed,
    keep_reason: payload.keep_reason || null,
    note: payload.note || null,
  };
}

function commitKeptTargets(root, experimentId, targetFiles) {
  const add = spawnSync('git', ['add', '--', ...targetFiles], { cwd: root, encoding: 'utf8' });
  if (add.status !== 0) {
    return { ok: false, error: add.stderr || add.stdout || 'git add failed' };
  }
  const commit = spawnSync('git', ['commit', '-m', `experiment(${experimentId}): kept`], {
    cwd: root,
    encoding: 'utf8',
  });
  if (commit.status !== 0) {
    return { ok: false, error: commit.stderr || commit.stdout || 'git commit failed' };
  }
  return { ok: true };
}

function recordOutcome(root, {
  experimentId,
  decision,
  baseline,
  candidate,
  verifyPassed,
  keepReason,
  note,
  verifyCommand,
  writeLesson,
  upsertLessonMeta,
  lessonSlugFn,
}) {
  const slug = lessonSlugFn(`experiment-${experimentId}`);
  const explanation = decision === 'kept'
    ? `Daily experiment ${experimentId} kept (${keepReason}).`
    : `Daily experiment ${experimentId} reverted (${keepReason}).`;

  appendResultsTsv(root, {
    timestamp: new Date().toISOString(),
    experiment_id: experimentId,
    decision,
    baseline_passed: (baseline.passed || []).join(','),
    candidate_passed: (candidate.passed || []).join(','),
    verify_passed: verifyPassed == null ? '' : String(verifyPassed),
    note: note || '',
  });

  appendScorecardRow(root, buildScorecardRow({
    experiment_id: experimentId,
    decision,
    baseline_passed: baseline.passed || [],
    candidate_passed: candidate.passed || [],
    baseline_failed: baseline.failed || [],
    candidate_failed: candidate.failed || [],
    verify_passed: verifyPassed,
    keep_reason: keepReason,
    note: note || null,
  }));

  writeLesson(root, slug, decision === 'kept' ? 'pass' : 'fail', explanation);
  if (decision === 'kept' && verifyCommand) {
    upsertLessonMeta(root, slug, {
      status: 'pass',
      detector: verifyCommand,
      scope: 'atris-cli',
    });
  } else if (decision === 'reverted') {
    upsertLessonMeta(root, slug, {
      status: 'observed',
      scope: 'atris-cli',
      detector: null,
    });
  }
}

function runDaily(root, args = [], deps = {}) {
  const options = parseDailyArgs(args);
  const env = deps.env || process.env;
  const writeLesson = deps.writeLesson || require('../../commands/autopilot').writeLesson;
  const upsertLessonMeta = deps.upsertLessonMeta || require('../../commands/autopilot').upsertLessonMeta;
  const lessonSlugFn = deps.lessonSlug || require('../../commands/autopilot').lessonSlug;

  const respond = (payload, exitCode = 0) => {
    if (options.json) console.log(JSON.stringify(payload));
    else if (payload.message) console.log(payload.message);
    return exitCode;
  };

  const state = readDailyState(root);
  const today = todayDate();
  if (!options.force && state.last_run_date === today) {
    return respond({
      ok: true,
      skipped: true,
      reason: 'already_ran_today',
      last_run_date: state.last_run_date,
    }, 0);
  }

  const entry = pickQueueEntry(root, state.history);
  if (!entry) {
    return respond({ ok: true, skipped: true, reason: 'queue_empty' }, 0);
  }

  const targetFiles = Array.isArray(entry.target_files) ? entry.target_files : [];
  if (!entry.id || !entry.apply || targetFiles.length === 0) {
    return respond({ ok: false, error: 'invalid_queue_entry', id: entry.id || null }, 1);
  }

  const clean = areTargetsClean(root, targetFiles);
  if (!clean.clean) {
    return respond({ ok: false, error: 'dirty_targets', reason: clean.reason, experiment_id: entry.id }, 1);
  }

  if (options.dryRun) {
    return respond({
      ok: true,
      dry_run: true,
      experiment_id: entry.id,
      target_files: targetFiles,
      apply: entry.apply,
      verify: entry.verify || null,
    }, 0);
  }

  const baselineRun = runBench(root, { label: 'baseline', experimentId: entry.id, env });
  if (benchInfraError(baselineRun.exitCode)) {
    return respond({
      ok: false,
      aborted: true,
      stage: 'baseline',
      experiment_id: entry.id,
      error: 'bench_infra_error',
      stderr: baselineRun.stderr.slice(0, 500),
    }, 1);
  }

  const baseline = parseBenchResult(baselineRun.parsed);
  const backups = new Map();
  for (const rel of targetFiles) {
    const abs = path.join(root, rel);
    backups.set(rel, fs.readFileSync(abs));
  }

  const applyResult = runApplyScript(root, entry.apply);
  if (applyResult.status !== 0) {
    for (const [rel, bytes] of backups) {
      fs.writeFileSync(path.join(root, rel), bytes);
    }
    const applyError = String(applyResult.stderr || applyResult.error || `exit ${applyResult.status}`)
      .replace(/\s+/g, ' ').trim().slice(0, 200);
    recordOutcome(root, {
      experimentId: entry.id,
      decision: 'reverted',
      baseline,
      candidate: { passed: [], failed: [], skipped: [] },
      verifyPassed: null,
      keepReason: 'apply_failed',
      note: `${entry.note || ''} [apply error: ${applyError}]`.trim(),
      verifyCommand: entry.verify || null,
      writeLesson,
      upsertLessonMeta,
      lessonSlugFn,
    });
    state.last_run_date = today;
    if (!state.history.includes(entry.id)) state.history.push(entry.id);
    writeDailyState(root, state);
    return respond({
      ok: false,
      experiment_id: entry.id,
      decision: 'reverted',
      reason: 'apply_failed',
    }, 1);
  }

  const candidateRun = runBench(root, { label: 'candidate', experimentId: entry.id, env });
  if (benchInfraError(candidateRun.exitCode)) {
    for (const [rel, bytes] of backups) {
      fs.writeFileSync(path.join(root, rel), bytes);
    }
    recordOutcome(root, {
      experimentId: entry.id,
      decision: 'reverted',
      baseline,
      candidate: { passed: [], failed: [], skipped: [] },
      verifyPassed: null,
      keepReason: 'candidate_bench_infra_error',
      note: entry.note || '',
      verifyCommand: entry.verify || null,
      writeLesson,
      upsertLessonMeta,
      lessonSlugFn,
    });
    state.last_run_date = today;
    if (!state.history.includes(entry.id)) state.history.push(entry.id);
    writeDailyState(root, state);
    return respond({
      ok: false,
      experiment_id: entry.id,
      decision: 'reverted',
      reason: 'candidate_bench_infra_error',
    }, 1);
  }

  const candidate = parseBenchResult(candidateRun.parsed);
  let verifyPassed = null;
  if (entry.verify) {
    const verifyResult = runVerifyCommand(root, entry.verify);
    verifyPassed = verifyResult.status === 0;
  }

  const keepEval = evaluateKeepRule({
    baseline,
    candidate,
    verifyPassed,
    keepIfAllPass: options.keepIfAllPass,
  });

  let decision = keepEval.keep ? 'kept' : 'reverted';
  if (decision === 'kept') {
    const commit = commitKeptTargets(root, entry.id, targetFiles);
    if (!commit.ok) {
      for (const [rel, bytes] of backups) {
        fs.writeFileSync(path.join(root, rel), bytes);
      }
      decision = 'reverted';
      keepEval.reason = 'commit_failed';
    }
  }

  if (decision === 'reverted') {
    for (const [rel, bytes] of backups) {
      fs.writeFileSync(path.join(root, rel), bytes);
    }
  }

  recordOutcome(root, {
    experimentId: entry.id,
    decision,
    baseline,
    candidate,
    verifyPassed,
    keepReason: keepEval.reason,
    note: entry.note || '',
    verifyCommand: entry.verify || null,
    writeLesson,
    upsertLessonMeta,
    lessonSlugFn,
  });

  state.last_run_date = today;
  if (!state.history.includes(entry.id)) state.history.push(entry.id);
  writeDailyState(root, state);

  return respond({
    ok: decision === 'kept',
    experiment_id: entry.id,
    decision,
    keep_reason: keepEval.reason,
    baseline_passed: baseline.passed,
    candidate_passed: candidate.passed,
    verify_passed: verifyPassed,
  }, decision === 'kept' ? 0 : 1);
}

function queueAdd(root, args = []) {
  const parsed = parseQueueAddArgs(args);
  if (!parsed.id || parsed.target.length === 0 || !parsed.apply) {
    console.error('Usage: atris experiments queue add <id> --target <file>[,<file>] --apply <script> [--verify "<cmd>"] [--note "..."]');
    return 1;
  }

  appendQueueEntry(root, {
    id: parsed.id,
    kind: 'patch',
    target_files: parsed.target,
    apply: parsed.apply,
    verify: parsed.verify || null,
    note: parsed.note || '',
    added: new Date().toISOString(),
  });
  console.log(`✓ Queued experiment ${parsed.id}`);
  return 0;
}

function queueList(root, args = []) {
  const json = args.includes('--json');
  const entries = readQueue(root);
  if (json) {
    console.log(JSON.stringify({ entries }, null, 2));
  } else if (entries.length === 0) {
    console.log('Queue is empty.');
  } else {
    for (const entry of entries) {
      console.log(`${entry.id}\t${(entry.target_files || []).join(',')}\t${entry.apply}`);
    }
  }
  return 0;
}

module.exports = {
  SCORECARD_SCHEMA,
  BENCH_SCHEMA,
  appendQueueEntry,
  appendResultsTsv,
  appendScorecardRow,
  areTargetsClean,
  buildScorecardRow,
  evaluateKeepRule,
  parseBenchResult,
  parseDailyArgs,
  parseQueueAddArgs,
  pickQueueEntry,
  queueAdd,
  queueList,
  readDailyState,
  readQueue,
  runApplyScript,
  runBench,
  runDaily,
  writeDailyState,
};
