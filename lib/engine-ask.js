'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const {
  DEFAULT_CLAUDE_RUNNER_MODEL,
  RUNNER_PROFILE_DEFS,
} = require('./runner-command');
const { canonicalEngineName } = require('./engine-registry');

const DEFAULT_ASK_CONCURRENCY = 3;
const DEFAULT_ASK_TIMEOUT_MS = 120000;
const MAX_ASK_CONCURRENCY = 4;
const MAX_ASK_JOBS = 8;
const MAX_ASK_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_ASK_PROMPT_BYTES = 16 * 1024;
const MAX_ASK_TOTAL_PROMPT_BYTES = 64 * 1024;
const MAX_ASK_OUTPUT_BYTES = 1024 * 1024;
const ASK_STOP_GRACE_MS = 250;
const ASK_MODEL_ENGINES = new Set(['claude', 'fable', 'haiku', 'codex', 'cursor', 'devin', 'grok']);
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
    `  --timeout <sec>    per-engine timeout, 1-${MAX_ASK_TIMEOUT_MS / 1000} (default ${DEFAULT_ASK_TIMEOUT_MS / 1000})`,
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
  const model = String(job.model || '').trim();
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
  let timeoutMs = DEFAULT_ASK_TIMEOUT_MS;
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

  if (help) return { help: true, json, jobs: [], concurrency, timeoutMs };
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
  return { help: false, json, jobs: labelAskJobs(jobs), concurrency, timeoutMs };
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

function buildReadOnlyEngineInvocation(engineName, prompt, modelName = '') {
  const engine = canonicalEngineName(engineName);
  const profile = RUNNER_PROFILE_DEFS[engine];
  if (!profile) throw new Error(`unknown engine "${engineName}"`);
  const model = String(modelName || '').trim();
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
  if (engine === 'droid') {
    return { engine, bin: profile.bin, args: ['exec', '--disable-builtin-skills', request] };
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

function runAskProcess(invocation, {
  cwd = process.cwd(),
  timeoutMs = DEFAULT_ASK_TIMEOUT_MS,
  spawnProcess = spawn,
  killProcess = process.kill.bind(process),
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
    let timeoutTimer;
    let hardStopTimer = null;
    let closeCode = null;
    let closeSignal = null;

    const finish = (code, signal, spawnError) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeoutTimer);
      if (hardStopTimer) clearTimeout(hardStopTimer);
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      const hasOutput = Boolean(stdout.trim() || stderr.trim());
      const ok = !timedOut && !spawnError && code === 0 && hasOutput;
      let reason = 'ok';
      if (timedOut) reason = 'timeout';
      else if (spawnError) reason = 'spawn_error';
      else if (code !== 0) reason = `exit_${code == null ? 'unknown' : code}`;
      else if (!hasOutput) reason = 'no_output';
      resolve({
        ok,
        reason,
        exit_code: Number.isInteger(code) ? code : null,
        signal: signal || null,
        timed_out: timedOut,
        stdout,
        stderr: spawnError ? `${stderr}${stderr ? '\n' : ''}${spawnError.message || spawnError}` : stderr,
        output_truncated: stdoutState.truncated || stderrState.truncated,
        duration_ms: Date.now() - startedAt,
      });
    };

    const stopOwnProcessGroup = (signal) => {
      if (!child || !Number.isInteger(child.pid) || child.pid <= 0) return;
      try {
        if (process.platform === 'win32') child.kill(signal);
        else killProcess(-child.pid, signal);
      } catch {
        try { child.kill(signal); } catch {}
      }
    };

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

    if (child.stdout) child.stdout.on('data', (chunk) => appendCapped(stdoutChunks, chunk, stdoutState));
    if (child.stderr) child.stderr.on('data', (chunk) => appendCapped(stderrChunks, chunk, stderrState));
    child.once('error', (error) => finish(null, null, error));
    child.once('close', (code, signal) => {
      closeCode = code;
      closeSignal = signal;
      if (!timedOut) finish(code, signal, null);
    });
    timeoutTimer = setTimeout(() => {
      timedOut = true;
      stopOwnProcessGroup('SIGTERM');
      hardStopTimer = setTimeout(() => {
        hardStopTimer = null;
        stopOwnProcessGroup('SIGKILL');
        finish(closeCode, closeSignal || 'SIGTERM', null);
      }, ASK_STOP_GRACE_MS);
    }, timeoutMs);
  });
}

async function runEngineAskJobs(jobs, {
  root = process.cwd(),
  concurrency = DEFAULT_ASK_CONCURRENCY,
  timeoutMs = DEFAULT_ASK_TIMEOUT_MS,
  executeAskJob = null,
} = {}) {
  const answers = new Array(jobs.length);
  let nextIndex = 0;
  const execute = executeAskJob || (async (job) => {
    const invocation = buildReadOnlyEngineInvocation(job.engine, job.prompt, job.model);
    return runAskProcess(invocation, { cwd: invocation.cwd || root, timeoutMs });
  });
  const workerCount = Math.min(concurrency, jobs.length);

  async function work() {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= jobs.length) return;
      const job = jobs[index];
      try {
        assertAskModelSupported(job.engine, job.model);
        answers[index] = { ...job, ...(await execute(job, { root, timeoutMs, index })) };
      } catch (error) {
        answers[index] = {
          ...job,
          ok: false,
          reason: error && error.reason ? error.reason : 'runner_error',
          exit_code: null,
          signal: null,
          timed_out: false,
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
  if (answer.timed_out || answer.reason === 'timeout') return 'timed out';
  return answer.ok ? 'answered' : 'failed';
}

function engineAskReceipt(answers, { concurrency, timeoutMs, at = new Date().toISOString() }) {
  const receiptAnswers = answers.map((answer) => ({ ...answer, status: answerStatus(answer) }));
  const answered = receiptAnswers.filter((answer) => answer.status === 'answered').length;
  const failed = receiptAnswers.filter((answer) => answer.status === 'failed').length;
  const timedOut = receiptAnswers.filter((answer) => answer.status === 'timed out').length;
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
    summary: { answered, failed, timed_out: timedOut },
    answers: receiptAnswers,
  };
}

function writeEngineAskReceipt(root, receipt) {
  const runsDir = path.join(root, 'atris', 'runs');
  fs.mkdirSync(runsDir, { recursive: true });
  const stamp = receipt.at.replace(/[-:.TZ]/g, '');
  const suffix = crypto.randomBytes(4).toString('hex');
  const receiptPath = path.join(runsDir, `engine-ask-${stamp}-${process.pid}-${suffix}.json`);
  fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  return receiptPath;
}

function compactFailure(answer) {
  if (answer.reason === 'timeout') return `timed out after ${Math.round(answer.duration_ms / 1000)}s`;
  const detail = String(answer.stderr || '').trim().split(/\r?\n/).find(Boolean);
  return detail || answer.reason.replace(/_/g, ' ');
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

  const answers = await runEngineAskJobs(parsed.jobs, {
    root,
    concurrency: parsed.concurrency,
    timeoutMs: parsed.timeoutMs,
    executeAskJob: deps.executeAskJob,
  });
  const receipt = engineAskReceipt(answers, {
    concurrency: parsed.concurrency,
    timeoutMs: parsed.timeoutMs,
    at: deps.now ? deps.now().toISOString() : new Date().toISOString(),
  });
  const receiptPath = (deps.writeReceipt || writeEngineAskReceipt)(root, receipt);
  const relativeReceiptPath = path.relative(root, receiptPath) || receiptPath;

  if (parsed.json) {
    console.log(JSON.stringify({ ...receipt, receipt_path: relativeReceiptPath }, null, 2));
  } else {
    for (const answer of answers) {
      console.log(`\n${answer.label} (${answer.engine})`);
      const output = String(answer.stdout || '').trim() || String(answer.stderr || '').trim();
      if (answer.ok) console.log(output);
      else console.log(`failed: ${compactFailure(answer)}`);
    }
    console.log('\nsummary:');
    for (const answer of answers) {
      console.log(`  ${answer.label} (${answer.engine}): ${answerStatus(answer)}`);
    }
    console.log(`\nreceipt: ${relativeReceiptPath}\n`);
  }
  return receipt.summary.failed || receipt.summary.timed_out ? 1 : 0;
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
