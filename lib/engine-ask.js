'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const {
  DEFAULT_CLAUDE_RUNNER_MODEL,
  RUNNER_PROFILE_DEFS,
} = require('./runner-command');
const {
  canonicalEngineName,
  engineFailureHealthStatus,
  setEngineHealth,
} = require('./engine-registry');
const {
  appendEngineLiveLogChunk,
  createEngineLiveLog,
  engineTerminalStatus,
} = require('./engine-job-lifecycle');

const DEFAULT_ASK_CONCURRENCY = 3;
const DEFAULT_ASK_TIMEOUT_MS = 120000;
const MAX_ASK_CONCURRENCY = 4;
const MAX_ASK_JOBS = 8;
const MAX_ASK_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_FABLE_ASK_TIMEOUT_MS = MAX_ASK_TIMEOUT_MS;
const MAX_ASK_PROMPT_BYTES = 16 * 1024;
const MAX_ASK_TOTAL_PROMPT_BYTES = 64 * 1024;
const MAX_ASK_OUTPUT_BYTES = 1024 * 1024;
const ASK_STOP_GRACE_MS = 250;
const ASK_MODEL_ENGINES = new Set(['claude', 'fable', 'haiku', 'codex', 'cursor', 'devin', 'grok', 'agy']);
const READ_ONLY_PREAMBLE = [
  'This is a read-only request.',
  'Do not modify files, create worktrees, start background agents, or run commands with side effects.',
  'Return the answer in this process.',
].join(' ');

function askUsage() {
  return [
    'usage:',
    '  atris engine ask "<question>" --engine <name> [--engine <name> ...] [--model <name>]',
    '  atris engine ask --jobs <jobs.json>',
    '',
    'options:',
    '  --model <name>     exact model for every selected engine',
    `  --concurrency <n>  parallel runs, 1-${MAX_ASK_CONCURRENCY} (default ${DEFAULT_ASK_CONCURRENCY})`,
    `  --timeout <sec>    per-engine timeout, 1-${MAX_ASK_TIMEOUT_MS / 1000} (default ${DEFAULT_ASK_TIMEOUT_MS / 1000}; Fable ${DEFAULT_FABLE_ASK_TIMEOUT_MS / 1000})`,
    '  --json             print the receipt as json',
    '',
    `jobs files contain up to ${MAX_ASK_JOBS} objects: [{"engine":"codex","model":"optional","prompt":"question","label":"optional"}]`,
  ].join('\n');
}

function parseBoundedInteger(raw, flag, min, max) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${flag} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function normalizeAskJob(job, index) {
  if (!job || typeof job !== 'object' || Array.isArray(job)) {
    throw new Error(`job ${index + 1} must be an object`);
  }
  const requestedEngine = String(job.engine || '').trim();
  const engine = canonicalEngineName(requestedEngine);
  if (!engine) {
    throw new Error(`job ${index + 1} names an unknown engine "${requestedEngine}"`);
  }
  const prompt = String(job.prompt || '').trim();
  if (!prompt) throw new Error(`job ${index + 1} needs a prompt`);
  if (Buffer.byteLength(prompt) > MAX_ASK_PROMPT_BYTES) {
    throw new Error(`job ${index + 1} prompt must be ${MAX_ASK_PROMPT_BYTES} bytes or fewer`);
  }
  const model = resolveAskModel(engine, job.model);
  const label = String(job.label || '').trim();
  if (label.length > 80) throw new Error(`job ${index + 1} label must be 80 characters or fewer`);
  return { engine, model, prompt, label };
}

function labelAskJobs(jobs) {
  const totals = new Map();
  for (const job of jobs) totals.set(job.engine, (totals.get(job.engine) || 0) + 1);
  const seen = new Map();
  return jobs.map((job) => {
    if (job.label) return job;
    const number = (seen.get(job.engine) || 0) + 1;
    seen.set(job.engine, number);
    return { ...job, label: totals.get(job.engine) > 1 ? `${job.engine}-${number}` : job.engine };
  });
}

function parseEngineAskArgs(args, { root = process.cwd(), readFile = fs.readFileSync } = {}) {
  const promptParts = [];
  const requestedEngines = [];
  let jobsFile = '';
  let requestedModel = '';
  let modelFlagPresent = false;
  let concurrency = DEFAULT_ASK_CONCURRENCY;
  let timeoutMs = null;
  let json = false;
  let help = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = String(args[index]);
    if (arg === '--help' || arg === '-h') { help = true; continue; }
    if (arg === '--json') { json = true; continue; }
    if (arg === '--engine') { requestedEngines.push(String(args[index + 1] || '')); index += 1; continue; }
    if (arg.startsWith('--engine=')) { requestedEngines.push(arg.slice('--engine='.length)); continue; }
    if (arg === '--engines') { requestedEngines.push(...String(args[index + 1] || '').split(',')); index += 1; continue; }
    if (arg.startsWith('--engines=')) { requestedEngines.push(...arg.slice('--engines='.length).split(',')); continue; }
    if (arg === '--model') {
      modelFlagPresent = true;
      requestedModel = String(args[index + 1] || '').trim();
      index += 1;
      continue;
    }
    if (arg.startsWith('--model=')) {
      modelFlagPresent = true;
      requestedModel = arg.slice('--model='.length).trim();
      continue;
    }
    if (arg === '--jobs') { jobsFile = String(args[index + 1] || ''); index += 1; continue; }
    if (arg.startsWith('--jobs=')) { jobsFile = arg.slice('--jobs='.length); continue; }
    if (arg === '--concurrency') {
      concurrency = parseBoundedInteger(args[index + 1], '--concurrency', 1, MAX_ASK_CONCURRENCY);
      index += 1;
      continue;
    }
    if (arg.startsWith('--concurrency=')) {
      concurrency = parseBoundedInteger(arg.slice('--concurrency='.length), '--concurrency', 1, MAX_ASK_CONCURRENCY);
      continue;
    }
    if (arg === '--timeout') {
      timeoutMs = parseBoundedInteger(args[index + 1], '--timeout', 1, MAX_ASK_TIMEOUT_MS / 1000) * 1000;
      index += 1;
      continue;
    }
    if (arg.startsWith('--timeout=')) {
      timeoutMs = parseBoundedInteger(arg.slice('--timeout='.length), '--timeout', 1, MAX_ASK_TIMEOUT_MS / 1000) * 1000;
      continue;
    }
    if (arg.startsWith('--')) throw new Error(`unknown option ${arg}`);
    promptParts.push(arg);
  }

  if (help) return { help: true, json, jobs: [], concurrency, timeoutMs: timeoutMs || DEFAULT_ASK_TIMEOUT_MS };
  if (modelFlagPresent && !requestedModel) throw new Error('--model needs a name');
  const commonPrompt = promptParts.join(' ').trim();
  let jobs;
  if (jobsFile) {
    if (commonPrompt || requestedEngines.length || modelFlagPresent) {
      throw new Error('--jobs cannot be combined with a shared prompt, --engine, or --model');
    }
    const absoluteJobsFile = path.resolve(root, jobsFile);
    let parsed;
    try {
      parsed = JSON.parse(readFile(absoluteJobsFile, 'utf8'));
    } catch (error) {
      throw new Error(`could not read --jobs ${jobsFile}: ${error.message}`);
    }
    if (!Array.isArray(parsed)) throw new Error('--jobs must contain a json array');
    jobs = parsed.map(normalizeAskJob);
  } else {
    if (!commonPrompt || !requestedEngines.length) throw new Error(askUsage());
    jobs = requestedEngines.map((requestedEngine, index) => normalizeAskJob({
      engine: requestedEngine,
      model: requestedModel,
      prompt: commonPrompt,
    }, index));
  }

  if (!jobs.length) throw new Error('at least one engine ask job is required');
  if (jobs.length > MAX_ASK_JOBS) throw new Error(`engine ask accepts at most ${MAX_ASK_JOBS} jobs per run`);
  const totalPromptBytes = jobs.reduce((sum, job) => sum + Buffer.byteLength(job.prompt), 0);
  if (totalPromptBytes > MAX_ASK_TOTAL_PROMPT_BYTES) {
    throw new Error(`engine ask accepts at most ${MAX_ASK_TOTAL_PROMPT_BYTES} prompt bytes per run`);
  }
  const resolvedTimeoutMs = timeoutMs
    || (jobs.some((job) => job.engine === 'fable') ? DEFAULT_FABLE_ASK_TIMEOUT_MS : DEFAULT_ASK_TIMEOUT_MS);
  return { help: false, json, jobs: labelAskJobs(jobs), concurrency, timeoutMs: resolvedTimeoutMs };
}

function guardedPrompt(prompt) {
  return `${READ_ONLY_PREAMBLE}\n\n${prompt}`;
}

function assertAskModelSupported(engine, model) {
  if (!model || ASK_MODEL_ENGINES.has(engine)) return;
  const error = new Error(`${engine} does not support model selection for engine ask`);
  error.reason = 'model_not_supported';
  throw error;
}

function resolveAskModel(engine, modelName = '') {
  const requested = String(modelName || '').trim();
  if (requested) return requested;
  if (engine !== 'claude' && engine !== 'fable' && engine !== 'haiku') return '';
  return RUNNER_PROFILE_DEFS[engine]?.model || DEFAULT_CLAUDE_RUNNER_MODEL;
}

function buildReadOnlyEngineInvocation(engineName, prompt, modelName = '') {
  const engine = canonicalEngineName(engineName);
  const profile = RUNNER_PROFILE_DEFS[engine];
  if (!profile) throw new Error(`unknown engine "${engineName}"`);
  const model = resolveAskModel(engine, modelName);
  assertAskModelSupported(engine, model);
  const request = guardedPrompt(prompt);

  if (engine === 'atris-fast' || engine === 'composer') {
    return { engine, bin: profile.bin, args: ['--fast', '--cloud', '--print', request] };
  }
  if (engine === 'claude' || engine === 'fable' || engine === 'haiku') {
    return {
      engine,
      bin: profile.bin,
      args: [
        '-p', request,
        '--model', model || profile.model || DEFAULT_CLAUDE_RUNNER_MODEL,
        '--tools', 'Read,Glob,Grep,WebSearch,WebFetch',
        '--permission-mode', 'plan',
        '--safe-mode',
        '--no-session-persistence',
      ],
    };
  }
  if (engine === 'codex') {
    return {
      engine,
      bin: profile.bin,
      args: ['exec', ...(model ? ['-m', model] : []), '--sandbox', 'read-only', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--color', 'never', request],
    };
  }
  if (engine === 'cursor') {
    // Cursor pays roughly a minute of silent workspace setup in every
    // directory except the user's home, where the same ask answers in
    // seconds (measured 15+ runs, 2026-08-12). Asks are read-only, so
    // launch from home and skip the tax.
    return { engine, bin: profile.bin, cwd: os.homedir(), args: ['--trust', ...(model ? ['--model', model] : []), '-p', '--mode', 'ask', '--sandbox', 'enabled', request] };
  }
  if (engine === 'devin') {
    return { engine, bin: profile.bin, args: ['-p', request, ...(model ? ['--model', model] : []), '--permission-mode', 'auto', '--sandbox', '--respect-workspace-trust', 'false'] };
  }
  if (engine === 'grok') {
    return {
      engine,
      bin: profile.bin,
      args: ['--no-memory', '--no-subagents', '--permission-mode', 'plan', '--sandbox', 'read-only', ...(model ? ['--model', model] : []), '-p', request],
    };
  }
  if (engine === 'agy') {
    // agy prompts for tool permission even in plan mode and a headless ask
    // has no one to answer, so it denies itself `ls` and fails every ask
    // (verified live 2026-08-19). The sandbox keeps the run read-only while
    // skip-permissions lets sandboxed reads proceed unattended.
    return {
      engine,
      bin: profile.bin,
      args: ['--mode', 'plan', '--sandbox', '--dangerously-skip-permissions', ...(model ? ['--model', model] : []), '-p', request],
    };
  }
  throw new Error(`engine ask has no read-only command for ${engine}`);
}

function appendCapped(chunks, chunk, state) {
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
  if (state.bytes >= MAX_ASK_OUTPUT_BYTES) {
    if (buffer.length) state.truncated = true;
    return;
  }
  const available = MAX_ASK_OUTPUT_BYTES - state.bytes;
  chunks.push(buffer.subarray(0, available));
  state.bytes += Math.min(buffer.length, available);
  if (buffer.length > available) state.truncated = true;
}

function cancelledAskResult(job, extra = {}) {
  return {
    ...job,
    ok: false,
    reason: 'cancelled',
    exit_code: extra.exit_code == null ? null : extra.exit_code,
    signal: extra.signal || 'SIGTERM',
    timed_out: false,
    cancelled: true,
    stdout: extra.stdout || '',
    stderr: extra.stderr || '',
    output_truncated: Boolean(extra.output_truncated),
    duration_ms: extra.duration_ms || 0,
  };
}

function runAskProcess(invocation, {
  cwd = process.cwd(),
  timeoutMs = DEFAULT_ASK_TIMEOUT_MS,
  spawnProcess = spawn,
  killProcess = process.kill.bind(process),
  signal = null,
  onOutputChunk = null,
} = {}) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const stdoutChunks = [];
    const stderrChunks = [];
    const stdoutState = { bytes: 0, truncated: false };
    const stderrState = { bytes: 0, truncated: false };
    let child;
    let finished = false;
    let timedOut = false;
    let cancelled = false;
    let timeoutTimer;
    let hardStopTimer = null;
    let closeCode = null;
    let closeSignal = null;

    const finish = (code, closeSignalValue, spawnError) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeoutTimer);
      if (hardStopTimer) clearTimeout(hardStopTimer);
      if (signal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onAbort);
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      const hasOutput = Boolean(stdout.trim() || stderr.trim());
      const ok = !cancelled && !timedOut && !spawnError && code === 0 && hasOutput;
      let reason = 'ok';
      if (cancelled) reason = 'cancelled';
      else if (timedOut) reason = 'timeout';
      else if (spawnError) reason = 'spawn_error';
      else if (code !== 0) reason = `exit_${code == null ? 'unknown' : code}`;
      else if (!hasOutput) reason = 'no_output';
      resolve({
        ok,
        reason,
        exit_code: Number.isInteger(code) ? code : null,
        signal: closeSignalValue || null,
        timed_out: timedOut && !cancelled,
        cancelled,
        stdout,
        stderr: spawnError ? `${stderr}${stderr ? '\n' : ''}${spawnError.message || spawnError}` : stderr,
        output_truncated: stdoutState.truncated || stderrState.truncated,
        duration_ms: Date.now() - startedAt,
      });
    };

    const stopOwnProcessGroup = (stopSignal) => {
      if (!child || !Number.isInteger(child.pid) || child.pid <= 0) return;
      try {
        if (process.platform === 'win32') child.kill(stopSignal);
        else killProcess(-child.pid, stopSignal);
      } catch {
        try { child.kill(stopSignal); } catch {}
      }
    };

    const requestStop = () => {
      stopOwnProcessGroup('SIGTERM');
      if (hardStopTimer) return;
      hardStopTimer = setTimeout(() => {
        hardStopTimer = null;
        stopOwnProcessGroup('SIGKILL');
        finish(closeCode, closeSignal || 'SIGTERM', null);
      }, ASK_STOP_GRACE_MS);
    };

    const onAbort = () => {
      cancelled = true;
      if (!child) {
        finish(null, 'SIGTERM', null);
        return;
      }
      requestStop();
    };

    if (signal) {
      if (signal.aborted) {
        cancelled = true;
        finish(null, 'SIGTERM', null);
        return;
      }
      if (typeof signal.addEventListener === 'function') signal.addEventListener('abort', onAbort, { once: true });
    }

    try {
      child = spawnProcess(invocation.bin, invocation.args, {
        cwd,
        env: process.env,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      finish(null, null, error);
      return;
    }

    if (child.stdout) child.stdout.on('data', (chunk) => {
      appendCapped(stdoutChunks, chunk, stdoutState);
      if (onOutputChunk) onOutputChunk(chunk, 'stdout');
    });
    if (child.stderr) child.stderr.on('data', (chunk) => {
      appendCapped(stderrChunks, chunk, stderrState);
      if (onOutputChunk) onOutputChunk(chunk, 'stderr');
    });
    child.once('error', (error) => finish(null, null, error));
    child.once('close', (code, closeSignalValue) => {
      closeCode = code;
      closeSignal = closeSignalValue;
      if (timedOut || cancelled) stopOwnProcessGroup('SIGKILL');
      finish(code, closeSignalValue, null);
    });
    timeoutTimer = setTimeout(() => {
      if (cancelled || finished) return;
      timedOut = true;
      requestStop();
    }, timeoutMs);
  });
}

async function runEngineAskJobs(jobs, {
  root = process.cwd(),
  concurrency = DEFAULT_ASK_CONCURRENCY,
  timeoutMs = DEFAULT_ASK_TIMEOUT_MS,
  executeAskJob = null,
  signal = null,
  onOutputChunk = null,
} = {}) {
  const answers = new Array(jobs.length);
  let nextIndex = 0;
  const execute = executeAskJob || (async (job) => {
    const invocation = buildReadOnlyEngineInvocation(job.engine, job.prompt, job.model);
    return runAskProcess(invocation, { cwd: invocation.cwd || root, timeoutMs, signal, onOutputChunk });
  });
  const workerCount = Math.min(concurrency, jobs.length);

  async function work() {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= jobs.length) return;
      const job = jobs[index];
      if (signal && signal.aborted) {
        answers[index] = cancelledAskResult(job);
        continue;
      }
      try {
        assertAskModelSupported(job.engine, job.model);
        answers[index] = { ...job, ...(await execute(job, { root, timeoutMs, index, signal, onOutputChunk })) };
      } catch (error) {
        answers[index] = {
          ...job,
          ok: false,
          reason: error && error.reason ? error.reason : 'runner_error',
          exit_code: null,
          signal: null,
          timed_out: false,
          cancelled: false,
          stdout: '',
          stderr: String(error && error.message ? error.message : error),
          output_truncated: false,
          duration_ms: 0,
        };
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => work()));
  return answers;
}

function answerStatus(answer) {
  return engineTerminalStatus(answer);
}

function recordEngineAskHealth(answers, root) {
  for (const answer of answers) {
    const status = answer.ok
      ? 'ready'
      : engineFailureHealthStatus({ ...answer, status: 'errored' });
    if (status) setEngineHealth(answer.engine, status, root);
  }
}

function engineAskReceipt(answers, { concurrency, timeoutMs, at = new Date().toISOString() }) {
  const receiptAnswers = answers.map((answer) => ({ ...answer, status: answerStatus(answer) }));
  const answered = receiptAnswers.filter((answer) => answer.status === 'answered').length;
  const failed = receiptAnswers.filter((answer) => answer.status === 'failed').length;
  const timedOut = receiptAnswers.filter((answer) => answer.status === 'timed out').length;
  const cancelled = receiptAnswers.filter((answer) => answer.status === 'cancelled').length;
  return {
    schema: 'atris.engine_ask_receipt.v1',
    at,
    read_only: true,
    limits: {
      jobs: answers.length,
      max_jobs: MAX_ASK_JOBS,
      max_prompt_bytes: MAX_ASK_PROMPT_BYTES,
      max_total_prompt_bytes: MAX_ASK_TOTAL_PROMPT_BYTES,
      concurrency,
      max_concurrency: MAX_ASK_CONCURRENCY,
      timeout_ms: timeoutMs,
    },
    summary: { answered, failed, timed_out: timedOut, cancelled },
    answers: receiptAnswers,
  };
}

function processGroupId(pid = process.pid) {
  if (process.platform === 'win32') return null;
  const result = spawnSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' });
  if (result.status !== 0) return null;
  const pgid = Number(String(result.stdout || '').trim());
  return Number.isInteger(pgid) && pgid > 0 ? pgid : null;
}

function atomicWriteEngineAskReceipt(receiptPath, receipt) {
  const tmpPath = path.join(path.dirname(receiptPath), `.${path.basename(receiptPath)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(tmpPath, `${JSON.stringify(receipt, null, 2)}\n`);
    fs.renameSync(tmpPath, receiptPath);
  } finally {
    try { fs.unlinkSync(tmpPath); } catch {}
  }
  return receiptPath;
}

function createEngineAskReceipt(root, receipt) {
  const runsDir = path.join(root, 'atris', 'runs');
  fs.mkdirSync(runsDir, { recursive: true });
  const stamp = receipt.started_at.replace(/[-:.TZ]/g, '');
  const suffix = crypto.randomBytes(4).toString('hex');
  const receiptPath = path.join(runsDir, `engine-ask-${stamp}-${process.pid}-${suffix}.json`);
  return atomicWriteEngineAskReceipt(receiptPath, receipt);
}

function compactFailure(answer) {
  if (answer.reason === 'cancelled' || answer.cancelled) return 'cancelled';
  if (answer.reason === 'timeout') return `timed out after ${Math.round(answer.duration_ms / 1000)}s`;
  const detail = String(answer.stderr || '').trim().split(/\r?\n/).find(Boolean);
  return detail || String(answer.reason || 'failed').replace(/_/g, ' ');
}

async function runEngineAskCommand(args, root = process.cwd(), deps = {}) {
  let parsed;
  try {
    parsed = parseEngineAskArgs(args, { root, readFile: deps.readFile || fs.readFileSync });
  } catch (error) {
    console.error(`engine ask: ${error.message}`);
    return 2;
  }
  if (parsed.help) {
    console.log(askUsage());
    return 0;
  }

  const abort = deps.abortController || new AbortController();
  const startedAt = deps.now ? deps.now().toISOString() : new Date().toISOString();
  const engines = [...new Set(parsed.jobs.map((job) => job.engine))];
  const runningReceipt = {
    schema: 'atris.engine_ask_receipt.v1',
    status: 'running',
    pid: process.pid,
    pgid: processGroupId(),
    engine: engines.length === 1 ? engines[0] : 'multiple',
    engines,
    started_at: startedAt,
    at: startedAt,
    read_only: true,
  };
  const receiptPath = (deps.createReceipt || createEngineAskReceipt)(root, runningReceipt);
  const relativeReceiptPath = path.relative(root, receiptPath) || receiptPath;
  const liveLogPath = (deps.createLiveLog || createEngineLiveLog)(receiptPath);
  runningReceipt.live_log = path.relative(root, liveLogPath) || liveLogPath;
  (deps.updateReceipt || atomicWriteEngineAskReceipt)(receiptPath, runningReceipt);
  const appendLiveLog = deps.appendLiveLog
    || ((filePath, chunk) => appendEngineLiveLogChunk(filePath, chunk));
  let interruptedSignal = '';
  let finalized = false;
  const writeFinal = (receipt) => {
    (deps.updateReceipt || atomicWriteEngineAskReceipt)(receiptPath, receipt);
    finalized = true;
  };
  const signalHandlers = deps.abortController ? [] : ['SIGINT', 'SIGTERM', 'SIGHUP'].map((signalName) => {
    const handler = () => {
      interruptedSignal = interruptedSignal || signalName;
      abort.abort();
    };
    process.once(signalName, handler);
    return [signalName, handler];
  });
  const onExit = () => {
    if (finalized) return;
    try {
      writeFinal({
        ...runningReceipt,
        status: interruptedSignal ? 'cancelled' : 'failed',
        signal: interruptedSignal || null,
        finished_at: new Date().toISOString(),
        error: interruptedSignal ? 'engine ask interrupted' : 'engine ask exited before completion',
      });
    } catch {}
  };
  process.once('exit', onExit);

  try {
    const answers = await runEngineAskJobs(parsed.jobs, {
      root,
      concurrency: parsed.concurrency,
      timeoutMs: parsed.timeoutMs,
      executeAskJob: deps.executeAskJob,
      signal: abort.signal,
      onOutputChunk: (chunk, stream) => appendLiveLog(liveLogPath, chunk, stream),
    });
    recordEngineAskHealth(answers, root);
    const receipt = engineAskReceipt(answers, {
      concurrency: parsed.concurrency,
      timeoutMs: parsed.timeoutMs,
      at: startedAt,
    });
    let status = 'completed';
    if (interruptedSignal || receipt.summary.cancelled) status = 'cancelled';
    else if (receipt.summary.timed_out) status = 'timed_out';
    else if (receipt.summary.failed) status = 'failed';
    writeFinal({
      ...receipt,
      status,
      pid: runningReceipt.pid,
      pgid: runningReceipt.pgid,
      engine: runningReceipt.engine,
      engines,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      signal: interruptedSignal || null,
      live_log: runningReceipt.live_log,
    });

    if (parsed.json) {
      console.log(JSON.stringify({ ...receipt, status, receipt_path: relativeReceiptPath, live_log: runningReceipt.live_log }, null, 2));
    } else {
      for (const answer of answers) {
        console.log(`\n${answer.label} (${answer.engine})`);
        const output = String(answer.stdout || '').trim() || String(answer.stderr || '').trim();
        if (answer.ok) console.log(output);
        else console.log(`failed: ${compactFailure(answer)}`);
      }
      console.log('\nsummary:');
      for (const answer of answers) console.log(`  ${answer.label} (${answer.engine}): ${answerStatus(answer)}`);
      console.log(`\nreceipt: ${relativeReceiptPath}\n`);
    }
    return receipt.summary.failed || receipt.summary.timed_out || receipt.summary.cancelled ? 1 : 0;
  } catch (error) {
    writeFinal({
      ...runningReceipt,
      status: interruptedSignal ? 'cancelled' : 'failed',
      signal: interruptedSignal || null,
      finished_at: new Date().toISOString(),
      error: String(error && error.message ? error.message : error),
    });
    throw error;
  } finally {
    for (const [signalName, handler] of signalHandlers) process.removeListener(signalName, handler);
    process.removeListener('exit', onExit);
  }
}

module.exports = {
  MAX_ASK_CONCURRENCY,
  MAX_ASK_JOBS,
  MAX_ASK_PROMPT_BYTES,
  parseEngineAskArgs,
  buildReadOnlyEngineInvocation,
  runAskProcess,
  runEngineAskJobs,
  runEngineAskCommand,
};
