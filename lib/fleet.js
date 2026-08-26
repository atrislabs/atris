'use strict';

// The fleet conductor's primitives. Humble name outside (`atris mission run
// --fleet`), the full loop inside: staff every idle engine on claimable
// safe-lane tasks, one mission per task, one worktree per engine, land
// arrivals serially. Proven by hand on 2026-07-02 (PRs #191-193, three
// engines) before any of this code existed — each function here is one thing
// the orchestrator did manually that day.
//
// INVARIANT: the fleet has NO state file. Flight state IS missions +
// worktrees + receipts. Kill a flight mid-run and nothing is orphaned — it
// is just missions in flight, resumable the normal way.

const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const {
  appendBriefRecord,
  mirrorBriefRecord,
  stampBriefOutcome,
  worktreeBaseRef,
} = require('./brief-ledger');
const { RUNNER_PROFILE_DEFS, buildRunnerCommand } = require('./runner-command');
const { engineFailureHealthStatus, setEngineHealth } = require('./engine-registry');
const { resolveDefaultVerifier } = require('./default-verifier');
const { rankEnginesDetailed } = require('./router-brain');
const {
  buildOneLapValidatorPrompt,
  parseOneLapValidatorVerdict,
} = require('./one-lap-validator');
const { listWorktrees, defaultMainlineBase } = require('../commands/worktree');
const { isConductorStatusLine } = require('./conductor-artifacts');
const { matchLessons } = require('./lesson-preflight');
const { matchTaste } = require('./taste-lessons');
const { buildVerifiedScoutPack, appendVerifiedScoutPack } = require('./dispatch-scout');
const {
  applySecretGrantEnvironment,
  buildGatewaySupervisorScript,
  spawnBlocking,
  PROXY_ENV_KEYS: SECRET_GATEWAY_PROXY_ENV_KEYS,
} = require('./secret-gateway');
const { appendEngineLiveLogChunk, createEngineLiveLog, engineTerminalReason } = require('./engine-job-lifecycle');

// Lanes a fleet may never staff on its own: the human keeps irreversible
// calls. Mirrors the autoland denied lanes.
const DENIED_TAGS = ['billing', 'money', 'payments', 'deploy', 'security', 'customer', 'external', 'feedback'];

// ---------------------------------------------------------------------------
// T1 — dispatch primitive

// A task's own text is its spec: the board convention writes "Done: ..." and
// "Check: ..." into the title/description. Extract both so the dispatch
// prompt is generated, never hand-written.
function parseDoneCheck(text) {
  const s = String(text || '');
  const done = (s.match(/Done:\s*([^]*?)(?=Check:|$)/i) || [])[1];
  const check = (s.match(/Check:\s*([^]*?)$/i) || [])[1];
  return {
    done: done ? done.trim().replace(/\s+/g, ' ') : '',
    check: check ? check.trim().replace(/\s+/g, ' ') : '',
  };
}

// Working-method kernel every dispatched engine inherits, distilled from
// atris/skills/fable-method: verify unpiped, receipts, caller sweeps,
// hypothesis-driven unsticking, smallest diff.
const METHOD_KERNEL = [
  'Read this whole brief before acting; locate every file you will touch before editing any of them.',
  'Never pipe a verify or test command through tail/head/grep — run it bare and read the real exit code.',
  'Done requires a receipt: paste the exact verify command and its final output lines in your report.',
  'Before deleting or renaming any function or call site, grep the whole repo for its callers; a caller outside your change means the contract stays intact.',
  'Stuck? Never run the same failing command a third time — write 3 one-line hypotheses, then run the cheapest test that discriminates between them.',
  'Smallest diff that satisfies Done wins; prefer deleting code over adding it.',
];

const ATRIS_BUILD_PROCESS_PREAMBLE = [
  'you are set up to do this well.',
  'use the atris process:',
  'claim the task, read the map, and work only the named contract.',
  'run every gate bare and read its real exit code.',
  'report honestly, including failures, and stop at the named stop point.',
  'if a git hook blocks your commit, stop and report it; never use --no-verify.',
].join('\n');

// The bounded prompt every engine gets. Same contract the manual flight used:
// isolated worktree, commit never push, MAP first, focused verify, report.
function buildFleetPrompt(task, { worktreePath, yolo = false } = {}) {
  const ref = task.display_id || task.id || 'TASK';
  const title = String(task.title || '').trim();
  const { done, check: declaredCheck } = parseDoneCheck(title);
  const check = declaredCheck || resolveDefaultVerifier(worktreePath || process.cwd());
  const commitRule = yolo
    ? 'Commit on the current branch with a plain-English message, then land it yourself: run atris worktree ship --message "<msg>" --verify "npm run test:fast && node --test <focused files>" --merge and report the PR URL. If ship reports a rebase conflict or the verify fails, stop and report; never resolve conflicts yourself.'
    : 'Commit on the current branch with a clear message. Do not push. Do not create branches.';
  const lines = [
    'First, run `atris worktree guard`; if it fails, stop immediately, report back, and do not edit anything. Do this before any file edit.',
    '',
    ATRIS_BUILD_PROCESS_PREAMBLE,
    '',
    `You are working task ${ref} in this repo checkout (an isolated git worktree${worktreePath ? ` at ${worktreePath}` : ''} — commit here, NEVER push).`,
    '',
    `Task: ${title}`,
    '',
  ];
  if (done) lines.push(`Done criteria: ${done}`, '');
  lines.push(`Check: ${check}`, '');
  lines.push(
    'Rules:',
    '- Read atris/MAP.md first to locate the code; never guess file locations.',
    '- Keep one concern per PR; split anything larger into separate PRs because git history guides future agents and small PRs are cheap to revert and bisect.',
    '- Run git status first. Stage ONLY files you changed. Never revert or touch files another agent modified.',
    '- Include or update a focused regression test; run it with npm run test:fast && node --test <focused files> before committing.',
    `- ${commitRule}`,
    ...METHOD_KERNEL.map((rule) => `- ${rule}`),
    '',
    'Final report (plain text): files changed, test command + result, commit sha (or say the commit failed and why).'
  );
  const lessonFiles = [
    ...(Array.isArray(task.files) ? task.files : []),
    ...(Array.isArray(task.metadata && task.metadata.files) ? task.metadata.files : []),
    ...fileSurface(task),
  ];
  const briefText = lines.join('\n');
  const preflightRoot = worktreePath || process.cwd();
  const lessons = matchLessons({
    briefText,
    files: lessonFiles,
    root: preflightRoot,
  });
  if (lessons.length) {
    lines.push('', '## lessons that apply', ...lessons.map((lesson) => `- ${lesson.text}`));
  }
  const requestedTasteScope = String(
    task.scope || (task.metadata && task.metadata.scope) || task.tag || 'any'
  ).toLowerCase();
  const taste = matchTaste({ briefText, scope: requestedTasteScope, root: preflightRoot });
  if (taste.length) {
    lines.push('', "## the owner's taste", ...taste.map((entry) => (
      `- The operator's verdict is ${entry.verdict} for "${entry.subject}". The reason is: ${entry.why}`
    )));
  }
  return lines.join('\n');
}

// Shell command that runs one engine on one prompt file, from the worktree.
// Rides the same profile definitions the whole CLI uses — no fleet-only
// spawn shapes.
// Build work needs file tools: allowedTools reaches the default claude-shaped
// spawn; template engines (cursor/codex/devin) ignore it — their CLIs manage
// their own permissions.
const FLEET_ALLOWED_TOOLS = 'Bash,Read,Edit,Write,Grep,Glob';
const VALIDATOR_ALLOWED_TOOLS = 'Bash,Read,Grep,Glob';
const DEAD_ENGINE_OUTPUT_PATTERNS = Object.freeze([
  'usage limit',
  'purchase more credits',
  'rate limit',
]);
const YOLO_ENGINE_FLAGS = Object.freeze({
  codex: '--dangerously-bypass-approvals-and-sandbox',
  claude: '--dangerously-skip-permissions',
});
const DISPATCH_SELF_LAND_TARGET = 'origin/master';

// Dispatch used to cut every build worktree from origin/master and check
// self-landing against it, hard-coded. A workspace whose protected branch is
// `main` had no origin/master, so the worktree cut and the ancestry check both
// failed. Resolve the workspace's real protected branch instead (remote HEAD,
// then origin/main), falling back to the historical origin/master when nothing
// else can be determined so single-branch repos and test roots behave as before.
function resolveDispatchLandTarget(root, explicitBase) {
  if (explicitBase) return explicitBase;
  try {
    const mainline = defaultMainlineBase(root);
    if (mainline && mainline !== 'HEAD') return mainline;
  } catch {}
  return DISPATCH_SELF_LAND_TARGET;
}
const DEFAULT_DISPATCH_TIMEOUT_MS = 900000;
const CODEX_DISPATCH_TIMEOUT_MS = 3660000;
const CODEX_WATCHDOG_SOURCE = path.join(__dirname, '..', 'scripts', 'det', 'codex-watchdog.js');

function realpathOrResolve(value) {
  const resolved = path.resolve(String(value));
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function assertIsolatedWorktree(worktreePath, root = process.cwd()) {
  if (!worktreePath) {
    throw new Error('fleet dispatch blocked: worktreePath is required; refusing to dispatch without an isolated worktree');
  }
  const resolvedWorktree = realpathOrResolve(worktreePath);
  const worktrees = listWorktrees(root);
  const primaryRoot = realpathOrResolve(worktrees[0]?.path || root);
  if (resolvedWorktree === primaryRoot) {
    throw new Error(`fleet dispatch blocked: worktreePath resolves to the primary repo checkout (${primaryRoot}); refusing to dispatch outside an isolated worktree`);
  }
  return { worktreePath: resolvedWorktree, primaryRoot };
}

function wrapCodexWithWatchdog(cmd, watchdogPath = CODEX_WATCHDOG_SOURCE, receiptPath = '') {
  // Codex hangs forever at startup when stdin is an open pipe (three real
  // flights on 2026-08-11 sat 50-100 minutes at zero CPU). Force every fleet
  // codex spawn through the silent-start / runtime-cap watchdog with stdin
  // sealed, so orchestrator prompts cannot forget the convention.
  const receiptArg = receiptPath ? ` --receipt ${shellSingleQuote(receiptPath)}` : '';
  return `${shellSingleQuote(process.execPath)} ${shellSingleQuote(watchdogPath)} --startup-deadline 90 --max-runtime 3600${receiptArg} -- sh -c ${shellSingleQuote(cmd)} </dev/null`;
}

function buildEngineCommand(engineName, promptFile, { yolo = false, sealed = false, allowedTools = FLEET_ALLOWED_TOOLS, watchdogPath = CODEX_WATCHDOG_SOURCE, watchdogReceiptPath = '' } = {}) {
  if (!RUNNER_PROFILE_DEFS[engineName]) throw new Error(`unknown engine "${engineName}"`);
  const prev = process.env.ATRIS_RUNNER_PROFILE;
  process.env.ATRIS_RUNNER_PROFILE = engineName;
  try {
    let cmd = buildRunnerCommand({ promptFile, allowedTools });
    // devin's default is read-only for writes; fleet builds ALWAYS run in an
    // isolated worktree, so the conductor grants write permission here and
    // only here (the profile itself stays safe for non-worktree ticks).
    if (sealed && engineName === 'codex') {
      cmd = cmd.replace(/\bexec\b/, 'exec --sandbox workspace-write --ephemeral --ignore-user-config --ignore-rules');
    }
    if (sealed && (engineName === 'claude' || engineName === 'fable')) {
      cmd = `${cmd} --safe-mode --no-session-persistence --permission-mode acceptEdits --settings '${JSON.stringify({ sandbox: { enabled: true, autoAllowBashIfSandboxed: true } })}'`;
    }
    if (sealed && engineName === 'cursor') cmd = `${cmd} --sandbox enabled`;
    if (sealed && engineName === 'devin') return cmd.replace(/^devin -p /, 'devin -p --sandbox --permission-mode accept-edits ');
    // Headless print mode has one write gate: blocked by default, open with
    // --yolo (--auto-accept is interactive-only and does not lift it). Fleet
    // builds always run in an isolated worktree, so --yolo here rides the
    // same trust model as every other engine's sealed mode.
    if (sealed && engineName === 'commandcode') cmd = `${cmd} --yolo --trust`;
    if (sealed && engineName === 'grok') {
      cmd = `${cmd.replace(/\s+--always-approve\b/, '')} --sandbox enabled --permission-mode acceptEdits --no-memory --no-subagents`;
    }
    if (engineName === 'devin') return cmd.replace(/^devin -p /, 'devin -p --permission-mode dangerous ');
    if (yolo && engineName === 'codex') cmd = cmd.replace(/\bexec\b/, `exec ${YOLO_ENGINE_FLAGS.codex}`);
    if (yolo && (engineName === 'claude' || engineName === 'fable')) cmd = `${cmd} ${YOLO_ENGINE_FLAGS.claude}`;
    if (yolo && engineName === 'commandcode') cmd = `${cmd} --yolo`;
    if (engineName === 'codex') cmd = wrapCodexWithWatchdog(cmd, watchdogPath, watchdogReceiptPath);
    return cmd;
  } finally {
    if (prev === undefined) delete process.env.ATRIS_RUNNER_PROFILE;
    else process.env.ATRIS_RUNNER_PROFILE = prev;
  }
}

function trackedSandboxPids(stateFile, leaseFile) {
  const pids = new Set();
  let state = {};
  try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch {}
  const pgid = Number(state.pgid);
  if (Number.isInteger(pgid) && pgid > 0) {
    const grouped = spawnSync('/usr/bin/pgrep', ['-g', String(pgid)], { encoding: 'utf8' });
    for (const value of String(grouped.stdout || '').trim().split(/\s+/)) {
      const pid = Number(value);
      if (Number.isInteger(pid) && pid > 0) pids.add(pid);
    }
  }
  const leased = spawnSync('/usr/sbin/lsof', ['-t', leaseFile], { encoding: 'utf8' });
  for (const value of String(leased.stdout || '').trim().split(/\s+/)) {
    const pid = Number(value);
    if (Number.isInteger(pid) && pid > 0) pids.add(pid);
  }
  if (state.cwd) {
    const rooted = spawnSync('/usr/sbin/lsof', ['-a', '-d', 'cwd', '+D', String(state.cwd), '-t'], { encoding: 'utf8' });
    for (const value of String(rooted.stdout || '').trim().split(/\s+/)) {
      const pid = Number(value);
      if (Number.isInteger(pid) && pid > 0) pids.add(pid);
    }
  }
  pids.delete(process.pid);
  return { pgid, pids: [...pids] };
}

function terminateTrackedSandbox(stateFile, leaseFile) {
  for (const signal of ['SIGTERM', 'SIGKILL', 'SIGKILL']) {
    const tracked = trackedSandboxPids(stateFile, leaseFile);
    if (tracked.pgid > 0) {
      try { process.kill(-tracked.pgid, signal); } catch {}
    }
    for (const pid of tracked.pids) {
      try { process.kill(pid, signal); } catch {}
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
}

function terminateSameSandboxProfile(executable, args, options) {
  if (executable !== '/usr/bin/sandbox-exec' || args[0] !== '-p' || !args[1]) return;
  spawnSync(executable, ['-p', args[1], '/bin/kill', '-KILL', '-1'], {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    stdio: 'ignore',
    timeout: 5000,
  });
}

function spawnWithOutputChunks(executable, args, options = {}) {
  const {
    encoding,
    input,
    onOutputChunk,
    timeout,
    ...childOptions
  } = options;
  const child = spawn(executable, args, {
    ...childOptions,
    stdio: [input == null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  });
  if (input != null && child.stdin) {
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  }

  const stdoutChunks = [];
  const stderrChunks = [];
  let spawnError = null;
  let timeoutError = null;
  const capture = (chunks, stream) => (chunk) => {
    chunks.push(Buffer.from(chunk));
    if (typeof onOutputChunk === 'function') onOutputChunk(chunk, stream);
  };
  child.stdout.on('data', capture(stdoutChunks, 'stdout'));
  child.stderr.on('data', capture(stderrChunks, 'stderr'));
  child.on('error', (error) => { spawnError = error; });

  return new Promise((resolve) => {
    const timer = Number(timeout) > 0
      ? setTimeout(() => {
        timeoutError = new Error('spawn ETIMEDOUT');
        timeoutError.code = 'ETIMEDOUT';
        try { child.kill('SIGKILL'); } catch {}
      }, Number(timeout))
      : null;
    child.once('close', (status, signal) => {
      if (timer) clearTimeout(timer);
      const encode = (chunks) => {
        const output = Buffer.concat(chunks);
        return encoding ? output.toString(encoding) : output;
      };
      resolve({
        pid: child.pid,
        status,
        signal,
        stdout: encode(stdoutChunks),
        stderr: encode(stderrChunks),
        error: timeoutError || spawnError,
      });
    });
  });
}

function runInReapedProcessGroup(executable, args, options, controlDir, statusFile) {
  if (!controlDir || !statusFile) throw new Error('sealed execution requires isolated control and status paths');
  const supervisor = path.join(controlDir, 'sandbox-supervisor.js');
  const stateFile = path.join(controlDir, 'sandbox-process.json');
  const leaseFile = path.join(controlDir, 'sandbox-process.lease');
  const { onOutputChunk, ...baseSpawnOptions } = options;
  const spawnEnv = { ...(baseSpawnOptions.env || {}) };
  const gatewayPlanRaw = spawnEnv.ATRIS_ONE_LAP_SECRET_GATEWAY;
  let gatewayInput = null;
  if (gatewayPlanRaw) {
    let plan;
    try { plan = JSON.parse(gatewayPlanRaw); } catch {
      throw new Error('secret gateway plan is not valid json');
    }
    const secretEnv = String(plan && plan.grant && plan.grant.secretEnv || '');
    const secret = String(process.env[secretEnv] || '');
    if (!secretEnv || !secret) throw new Error('secret grant requires the parent secret value on stdin path');
    gatewayInput = JSON.stringify({
      grant: plan.grant,
      placeholder: plan.placeholder,
      secret,
      upstreamPort: plan.upstreamPort,
      upstreamAddress: plan.upstreamAddress,
      rejectUnauthorized: plan.rejectUnauthorized,
    });
    delete spawnEnv.ATRIS_ONE_LAP_SECRET_GATEWAY;
    spawnEnv.ATRIS_ONE_LAP_SECRET_GATEWAY_STDIN = '1';
    fs.writeFileSync(supervisor, buildGatewaySupervisorScript(require.resolve('./secret-gateway')), { mode: 0o700 });
  } else {
    fs.writeFileSync(supervisor, [
      "'use strict';",
      "const fs = require('node:fs');",
      "const { spawn, spawnSync } = require('node:child_process');",
      "const [stateFile, leaseFile, statusFile, executable, ...args] = process.argv.slice(2);",
      "const leaseFd = fs.openSync(leaseFile, 'w', 0o600);",
      "const statusFd = fs.openSync(statusFile, 'w', 0o600);",
      "const child = spawn(executable, args, { cwd: process.cwd(), env: process.env, detached: true, stdio: ['ignore', 'inherit', 'inherit', leaseFd, statusFd] });",
      "fs.closeSync(leaseFd);",
      "fs.closeSync(statusFd);",
      "fs.writeFileSync(stateFile, JSON.stringify({ pgid: child.pid, cwd: process.cwd() }) + '\\n', { mode: 0o600 });",
      "let stopping = false;",
      "const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));",
      "function trackedPids() {",
      "  const pids = new Set();",
      "  for (const [bin, argv] of [['/usr/bin/pgrep', ['-g', String(child.pid)]], ['/usr/sbin/lsof', ['-t', leaseFile]], ['/usr/sbin/lsof', ['-a', '-d', 'cwd', '+D', process.cwd(), '-t']]]) {",
      "    const found = spawnSync(bin, argv, { encoding: 'utf8' });",
      "    for (const value of String(found.stdout || '').trim().split(/\\s+/)) {",
      "      const pid = Number(value);",
      "      if (Number.isInteger(pid) && pid > 0) pids.add(pid);",
      "    }",
      "  }",
      "  pids.delete(process.pid);",
      "  return [...pids];",
      "}",
      "async function stop(code) {",
      "  if (stopping) return;",
      "  stopping = true;",
      "  if (executable === '/usr/bin/sandbox-exec' && args[0] === '-p' && args[1]) {",
      "    spawnSync(executable, ['-p', args[1], '/bin/kill', '-KILL', '-1'], { cwd: process.cwd(), env: process.env, stdio: 'ignore', timeout: 5000 });",
      "  }",
      "  for (const [signal, delay] of [['SIGTERM', 100], ['SIGKILL', 100], ['SIGKILL', 100]]) {",
      "    try { process.kill(-child.pid, signal); } catch {}",
      "    for (const pid of trackedPids()) { try { process.kill(pid, signal); } catch {} }",
      "    await wait(delay);",
      "  }",
      "  let exitCode = Number.isInteger(code) ? code : 128;",
      "  try {",
      "    const savedText = fs.readFileSync(statusFile, 'utf8').trim();",
      "    const saved = Number(savedText);",
      "    if (savedText && Number.isInteger(saved) && saved >= 0 && saved <= 255) exitCode = saved;",
      "  } catch {}",
      "  process.exit(exitCode);",
      "}",
      "child.once('error', () => { void stop(1); });",
      "child.once('exit', (code) => { void stop(code); });",
      "for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => { void stop(143); });",
      '',
    ].join('\n'), { mode: 0o700 });
  }
  const spawnOptions = { ...baseSpawnOptions, env: spawnEnv };
  if (gatewayInput) spawnOptions.input = gatewayInput;
  if (gatewayInput) {
    const exitFile = path.join(controlDir, 'sandbox-supervisor.exit');
    return spawnBlocking(
      process.execPath,
      [supervisor, exitFile, stateFile, leaseFile, statusFile, executable, ...args],
      {
        ...spawnOptions,
        exitFile,
        onStdoutChunk: onOutputChunk ? (chunk) => onOutputChunk(chunk, 'stdout') : undefined,
        onStderrChunk: onOutputChunk ? (chunk) => onOutputChunk(chunk, 'stderr') : undefined,
      },
    ).finally(() => {
      terminateSameSandboxProfile(executable, args, spawnOptions);
      terminateTrackedSandbox(stateFile, leaseFile);
    });
  }
  if (onOutputChunk) {
    return spawnWithOutputChunks(
      process.execPath,
      [supervisor, stateFile, leaseFile, statusFile, executable, ...args],
      { ...spawnOptions, onOutputChunk },
    ).finally(() => {
      terminateSameSandboxProfile(executable, args, spawnOptions);
      terminateTrackedSandbox(stateFile, leaseFile);
    });
  }
  let result;
  try {
    result = spawnSync(process.execPath, [supervisor, stateFile, leaseFile, statusFile, executable, ...args], spawnOptions);
  } finally {
    terminateSameSandboxProfile(executable, args, spawnOptions);
    terminateTrackedSandbox(stateFile, leaseFile);
  }
  return result;
}

function sandboxLifecycleWrapper(runtimeDir, controlDir) {
  const wrapper = path.join(runtimeDir, 'sandbox-lifecycle.sh');
  const statusFile = path.join(controlDir, 'sandbox-status');
  fs.writeFileSync(wrapper, [
    '#!/bin/sh',
    '"$@" 4>&-',
    'status=$?',
    'printf "%s\\n" "$status" >&4',
    "trap '' EXIT TERM INT HUP",
    '/bin/kill -TERM -1 2>/dev/null || true',
    '/bin/sleep 0.1',
    '/bin/kill -KILL -1 2>/dev/null || true',
    'exit "$status"',
    '',
  ].join('\n'), { mode: 0o700 });
  return { wrapper, statusFile };
}

function dispatchResultOutput(result) {
  if (!result) return '';
  return [
    result.report,
    result.stdout,
    result.stderr,
  ].map((value) => String(value || '')).filter(Boolean).join('\n');
}

function dispatchResultExitCode(result) {
  if (!result || typeof result !== 'object') return null;
  if (Object.prototype.hasOwnProperty.call(result, 'exitCode')) {
    return Number.isInteger(result.exitCode) ? result.exitCode : null;
  }
  if (Object.prototype.hasOwnProperty.call(result, 'status')) {
    return Number.isInteger(result.status) ? result.status : null;
  }
  return null;
}

// A child killed by a signal comes back either with spawnSync's `signal` field
// set (plain spawn) or a 128+N exit status (the sealed supervisor re-exits 143
// on SIGTERM). Either way stdout/report and stderr are empty, so name the
// signal instead of letting the leg read as a silent no-op (CLI-1190: on
// WEB-455 2026-07-25 the claude engine exited 143/SIGTERM with an empty report
// and the restaff receipt looked like nothing had happened).
const SIGNAL_EXIT_NAMES = Object.freeze({ 129: 'SIGHUP', 130: 'SIGINT', 137: 'SIGKILL', 143: 'SIGTERM' });
function dispatchResultSignal(result) {
  if (!result || typeof result !== 'object') return null;
  if (result.signal) return String(result.signal);
  const code = dispatchResultExitCode(result);
  return SIGNAL_EXIT_NAMES[code] || null;
}

function dispatchTaskId(task) {
  return task && (task.display_id || task.task_id || task.id) ? String(task.display_id || task.task_id || task.id) : '';
}

function dispatchBriefAuthor(worktreePath, fallback = 'orb') {
  try {
    const sidecar = JSON.parse(fs.readFileSync(path.join(worktreePath, '.atris', 'agent-worktree.json'), 'utf8'));
    return String(sidecar.owner || sidecar.member || sidecar.agent || fallback).trim() || fallback;
  } catch {
    return fallback;
  }
}

function captureDispatchBrief({ root, task, engine, worktreePath, prompt, missionId = '', author = '', yolo = false }) {
  const promptText = prompt || buildFleetPrompt(task, { worktreePath, yolo });
  const record = appendBriefRecord(root, {
    author: author || dispatchBriefAuthor(worktreePath, 'orb'),
    engine,
    task_id: dispatchTaskId(task),
    mission_id: missionId,
    prompt_text: promptText,
    context: {
      worktree: worktreePath,
      base_ref: worktreeBaseRef(worktreePath, ''),
    },
  });
  if (path.resolve(root) !== path.resolve(worktreePath || root)) {
    mirrorBriefRecord(worktreePath, record);
  }
  return record;
}

function stampDispatchBrief(root, briefId, result, note) {
  if (!briefId) return { ok: false, error: 'missing brief id' };
  try {
    return stampBriefOutcome(root, briefId, { result, note });
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function detectDeadEngineDispatch(result) {
  const terminal = dispatchResultToTerminal({}, result);
  const exitCode = terminal.exit_code;
  const signal = dispatchResultSignal(result);
  if (signal) return { reason: 'signalled', signal, exitCode };
  if (terminal.reason === 'ok') return null;
  const output = dispatchResultOutput(result).toLowerCase();
  const pattern = Number.isInteger(exitCode) && exitCode !== 0
    ? DEAD_ENGINE_OUTPUT_PATTERNS.find((p) => output.includes(p))
    : null;
  if (pattern) return { reason: 'usage_limit', pattern };
  if (terminal.reason === 'no_output' || terminal.reason === 'unknown' || terminal.reason === 'timeout' || terminal.reason === 'cancelled') {
    return { reason: terminal.reason, exitCode };
  }
  return { reason: 'nonzero_exit', exitCode };
}

function plainDispatchFailureCause(result, failure = {}) {
  const reason = String(failure.reason || failure.stage || '').trim();
  const output = dispatchResultOutput(result);
  if (reason === 'no_output') return 'the engine returned no output';
  if (/not authenticated|please log in|login required|auth(?:entication)?[ _-]?expired/i.test(output)) {
    return 'the engine login expired';
  }
  if (/spawn[^\n]*enoent|enoent[^\n]*spawn|failed to spawn/i.test(output)) {
    return 'the engine could not start';
  }
  if (reason === 'timeout') return 'the engine timed out';
  if (reason === 'cancelled') return 'the engine run was cancelled';
  if (reason === 'unknown') return 'the engine exited without a status';
  if (reason === 'signalled') return `the engine stopped with ${failure.signal || 'a signal'}`;
  const detail = String(failure.detail || output || '').trim().split('\n')[0].trim();
  if (detail) return detail.replace(/[.]+$/, '');
  return (reason || 'the engine failed').replace(/_/g, ' ');
}

function recordDispatchEngineHealth(result, failure, root) {
  if (!result || !result.engine) return null;
  const status = failure
    ? engineFailureHealthStatus({
      ...result,
      status: 'errored',
      reason: [result.reason, failure.reason].filter(Boolean).join('\n'),
    })
    : 'ready';
  return status ? setEngineHealth(result.engine, status, root) : null;
}

function normalizeInstalledEngines(engines) {
  return [...new Set((engines || [])
    .map((entry) => (typeof entry === 'string' ? entry : entry && entry.name))
    .map((name) => String(name || '').trim())
    .filter((name) => FLEET_CAPABLE.includes(name) && RUNNER_PROFILE_DEFS[name]))];
}

function installedFleetEngines(root) {
  const { roster } = require('../commands/engine');
  return normalizeInstalledEngines(roster(root).filter((e) => e.installed));
}

function rankFleetEnginesDetailed(engines, root = process.cwd(), options = {}) {
  return rankEnginesDetailed(normalizeInstalledEngines(engines), {
    root,
    taskType: 'executor',
    lowStakes: options.lowStakes === true,
  });
}

function rankFleetEngines(engines, root = process.cwd()) {
  return rankFleetEnginesDetailed(engines, root).candidates;
}

function nextInstalledFleetEngine(current, { root = process.cwd(), installedEngines = null } = {}) {
  const engines = installedEngines ? normalizeInstalledEngines(installedEngines) : installedFleetEngines(root);
  const currentName = String(current || '').trim();
  if (!engines.length) return '';
  const index = engines.indexOf(currentName);
  const ordered = index === -1
    ? engines
    : [...engines.slice(index + 1), ...engines.slice(0, index)];
  const candidates = ordered.filter((name) => name && name !== currentName);
  return rankFleetEngines(candidates, root)[0] || '';
}

function normalizeDispatchResult(result, engineName) {
  const normalized = { ...(result || {}) };
  normalized.engine = normalized.engine || engineName;
  normalized.exitCode = dispatchResultExitCode(normalized);
  return normalized;
}

function failedDispatchLeg(result, engineName) {
  const report = String(result && result.report || '').slice(-2000);
  const signal = dispatchResultSignal(result);
  const leg = {
    engine: String(result && result.engine || engineName || ''),
    exitCode: dispatchResultExitCode(result),
    stderr: String(result && result.stderr || '').slice(-2000),
    report,
  };
  if (signal) {
    // Record that the predecessor was killed; a signalled leg has no report of
    // its own, so name the signal in place of the empty string (CLI-1190).
    leg.signal = signal;
    if (!report) leg.report = `(no report: killed by ${signal})`;
  }
  if (result && result.watchdog_receipt) leg.watchdog_receipt = result.watchdog_receipt;
  return leg;
}

async function dispatchEntryWithRestaff({
  entry,
  engine,
  root,
  dispatch,
  installedEngines = null,
  restaffState,
  scoutAsk,
}) {
  const basePrompt = entry.prompt || buildFleetPrompt(entry.task, { worktreePath: entry.worktreePath, yolo: entry.yolo });
  let scoutPackPromise = null;
  const scoutPack = () => {
    if (scoutAsk === false) return Promise.resolve(null);
    if (!scoutPackPromise) {
      scoutPackPromise = buildVerifiedScoutPack({
        task: entry.task,
        worktreePath: entry.worktreePath,
        ask: typeof scoutAsk === 'function' ? scoutAsk : undefined,
      });
    }
    return scoutPackPromise;
  };
  const runOnce = async (engineName) => {
    const prompt = appendVerifiedScoutPack(basePrompt, await scoutPack(), { worktreePath: entry.worktreePath });
    const brief = captureDispatchBrief({
      root,
      task: entry.task,
      engine: engineName,
      worktreePath: entry.worktreePath,
      prompt,
      missionId: entry.mission_id || entry.missionId || '',
      author: entry.author || '',
      yolo: entry.yolo,
    });
    try {
      const runResult = normalizeDispatchResult(await dispatch({ ...entry, engine: engineName, prompt, brief_id: brief.brief_id, briefId: brief.brief_id, skipBriefCapture: true }), engineName);
      if (!runResult.brief_id) runResult.brief_id = brief.brief_id;
      return runResult;
    } catch (err) {
      return normalizeDispatchResult({
        brief_id: brief.brief_id,
        exitCode: 1,
        report: '',
        stderr: String(err && err.message || err),
      }, engineName);
    }
  };

  const first = await runOnce(engine);
  const deadEngine = detectDeadEngineDispatch(first);
  recordDispatchEngineHealth(first, deadEngine, root);
  if (!deadEngine) return first;
  stampDispatchBrief(root, first.brief_id, 'fail', `restaffed from ${engine}: ${deadEngine.reason}`);

  const outage = { from: engine, reason: deadEngine.reason };
  if (restaffState.used) {
    return { ...first, deadEngine: { ...outage, skipped: 'already_restaffed' } };
  }

  const fallback = nextInstalledFleetEngine(engine, { root, installedEngines });
  if (!fallback) {
    return { ...first, deadEngine: { ...outage, skipped: 'no_fallback_engine' } };
  }

  restaffState.used = true;
  const fallbackResult = await runOnce(fallback);
  recordDispatchEngineHealth(fallbackResult, detectDeadEngineDispatch(fallbackResult), root);
  return {
    ...fallbackResult,
    restaffed: {
      from: engine,
      to: fallback,
      reason: deadEngine.reason,
      failed_legs: [failedDispatchLeg(first, engine)],
    },
  };
}

// Run one engine on one task in one worktree. Blocking; the conductor runs
// dispatches in parallel via child processes, not threads. `runner` is
// injectable for tests. `prompt` is injectable too: a caller-supplied prompt
// (e.g. `atris engine dispatch --prompt-file`) skips the generated
// buildFleetPrompt text entirely.
function dispatchToEngine({ task, engine, worktreePath, root = process.cwd(), timeoutMs = null, runner = null, prompt: promptOverride = '', yolo = false, sealed = false, briefId = '', skipBriefCapture = false, environment = null, allowedTools = FLEET_ALLOWED_TOOLS, liveLogPath = '' }) {
  assertIsolatedWorktree(worktreePath, root);
  const prompt = promptOverride || buildFleetPrompt(task, { worktreePath, yolo });
  let capturedBriefId = briefId;
  if (!skipBriefCapture) {
    capturedBriefId = captureDispatchBrief({ root, task, engine, worktreePath, prompt, yolo }).brief_id;
  }
  const runtimeDir = String(environment && environment.ATRIS_ONE_LAP_RUNTIME_DIR || '');
  const promptFile = path.join(sealed && runtimeDir ? runtimeDir : path.join(worktreePath, '.atris'), `fleet-prompt-${task.display_id || 'task'}.md`);
  const runtimePath = path.dirname(promptFile);
  fs.mkdirSync(runtimePath, { recursive: true });
  fs.writeFileSync(promptFile, prompt);
  let watchdogPath = CODEX_WATCHDOG_SOURCE;
  let watchdogArtifact = '';
  if (engine === 'codex') {
    watchdogPath = path.join(runtimePath, 'codex-watchdog.js');
    fs.copyFileSync(CODEX_WATCHDOG_SOURCE, watchdogPath);
    const artifactDir = path.join(worktreePath, '.atris');
    fs.mkdirSync(artifactDir, { recursive: true });
    watchdogArtifact = path.join(artifactDir, `codex-watchdog-${task.display_id || 'task'}-${crypto.randomBytes(4).toString('hex')}.json`);
  }
  const command = buildEngineCommand(engine, promptFile, {
    yolo,
    sealed,
    allowedTools,
    watchdogPath,
    watchdogReceiptPath: watchdogArtifact,
  });
  const dispatchTimeoutMs = timeoutMs === null || timeoutMs === undefined
    ? (engine === 'codex' ? CODEX_DISPATCH_TIMEOUT_MS : DEFAULT_DISPATCH_TIMEOUT_MS)
    : timeoutMs;
  const exec = runner || ((cmd) => {
    const childEnv = sealed && environment
      ? { ...environment }
      : (environment ? { ...process.env, ...environment } : { ...process.env });
    const sandboxProfile = String(childEnv.ATRIS_ONE_LAP_SANDBOX_PROFILE || '');
    const cleanupRuntimeDir = String(childEnv.ATRIS_ONE_LAP_RUNTIME_DIR || '');
    const cleanupControlDir = String(childEnv.ATRIS_ONE_LAP_CONTROL_DIR || '');
    const lifecycleWrapper = String(childEnv.ATRIS_ONE_LAP_LIFECYCLE_WRAPPER || '');
    const statusFile = String(childEnv.ATRIS_ONE_LAP_STATUS_FILE || '');
    delete childEnv.ATRIS_ONE_LAP_SANDBOX_PROFILE;
    delete childEnv.ATRIS_ONE_LAP_RUNTIME_DIR;
    delete childEnv.ATRIS_ONE_LAP_CONTROL_DIR;
    delete childEnv.ATRIS_ONE_LAP_LIFECYCLE_WRAPPER;
    delete childEnv.ATRIS_ONE_LAP_STATUS_FILE;
    let deferredCleanup = false;
    const cleanup = () => {
      if (cleanupRuntimeDir) fs.rmSync(cleanupRuntimeDir, { recursive: true, force: true });
      if (cleanupControlDir) fs.rmSync(cleanupControlDir, { recursive: true, force: true });
    };
    try {
      const executable = sandboxProfile ? '/usr/bin/sandbox-exec' : 'sh';
      const args = sandboxProfile
        ? ['-p', sandboxProfile, lifecycleWrapper, '/bin/sh', '-c', cmd]
        : ['-c', cmd];
      const spawnOptions = {
        cwd: worktreePath,
        env: childEnv,
        encoding: 'utf8',
        timeout: dispatchTimeoutMs,
      };
      if (liveLogPath) {
        fs.mkdirSync(path.dirname(liveLogPath), { recursive: true });
        spawnOptions.onOutputChunk = (chunk) => appendEngineLiveLogChunk(liveLogPath, chunk);
      }
      const run = sandboxProfile
        ? runInReapedProcessGroup(executable, args, spawnOptions, cleanupControlDir, statusFile)
        : (liveLogPath ? spawnWithOutputChunks(executable, args, spawnOptions) : spawnSync(executable, args, spawnOptions));
      if (run && typeof run.then === 'function') {
        deferredCleanup = true;
        return run.finally(cleanup);
      }
      return run;
    } finally {
      if (!deferredCleanup) cleanup();
    }
  });
  const result = exec(command, { timeoutMs: dispatchTimeoutMs });
  const toDispatch = (run) => {
    let watchdogReceipt = null;
    if (watchdogArtifact && fs.existsSync(watchdogArtifact)) {
      try { watchdogReceipt = JSON.parse(fs.readFileSync(watchdogArtifact, 'utf8')); } catch {}
    }
    return {
      task: task.display_id || task.id,
      engine,
      worktreePath,
      promptFile,
      brief_id: capturedBriefId || null,
      command,
      watchdog_artifact: watchdogArtifact || null,
      watchdog_receipt: watchdogReceipt,
      exitCode: Number.isInteger(run.status) ? run.status : null,
      signal: run.signal || null,
      timed_out: Boolean(run.error && run.error.code === 'ETIMEDOUT'),
      cancelled: Boolean(run.cancelled),
      report: String(run.stdout || '').slice(-8000),
      stderr: String(run.stderr || '').slice(-2000),
    };
  };
  if (result && typeof result.then === 'function') return result.then(toDispatch);
  return toDispatch(result);
}

// ---------------------------------------------------------------------------
// T2 — staffing

const {
  taskTagTokens,
  isDecisionHoldTag,
  isDecisionTask,
  DECISION_REFUSE_REASON,
} = require('./task-decision');

function taskTags(task) {
  // Tags added after creation live in metadata.tags (`atris task tag`); a
  // fleet that only read task.tags/title hashtags would ignore an owner-hold
  // flag stamped on a live task and keep restaffing it (CLI-879).
  return taskTagTokens(task);
}

// A task flagged for a human decision is never fleet-staffable, whatever its
// lane. Mirrors the sweep's needs-human hold so both loops agree. Also honors
// the clearer `decision` tag so policy questions stay off autonomous lanes.
function isHumanHoldTag(tag) {
  return isDecisionHoldTag(tag);
}

function isSafeLane(task) {
  if (isDecisionTask(task)) return false;
  const tags = taskTags(task);
  return !tags.some((t) => DENIED_TAGS.includes(t));
}

// Rough file-surface guess from a task's text: paths and bare `commands/x.js`
// style mentions. Used only to keep concurrent picks disjoint — the merge
// conflict on 2026-07-02 (two engines in commands/mission.js) is the tax this
// avoids.
function fileSurface(task) {
  const text = String(task.title || '');
  const matches = text.match(/\b(?:commands|lib|bin|test|scripts)\/[A-Za-z0-9._/-]+/g) || [];
  return [...new Set(matches)];
}

function surfacesOverlap(a, b) {
  return a.some((f) => b.includes(f));
}

// Pick up to `slots` open, safe-lane, mutually file-disjoint tasks. Tasks
// whose surface cannot be guessed are allowed one at a time (the unknown
// surface could overlap anything).
function staffFlight(tasks, { slots = 3 } = {}) {
  const open = (tasks || []).filter((t) => t && t.status === 'open' && isSafeLane(t));
  const picked = [];
  let blindPicked = false;
  for (const task of open) {
    if (picked.length >= slots) break;
    const surface = fileSurface(task);
    if (surface.length === 0) {
      if (blindPicked) continue;
      blindPicked = true;
      picked.push({ task, surface });
      continue;
    }
    if (picked.some((p) => surfacesOverlap(p.surface, surface))) continue;
    picked.push({ task, surface });
  }
  return picked.map((p, i) => ({ task: p.task, surface: p.surface, slot: i }));
}

// Pair staffed tasks with installed engines, round-robin. `engines` comes
// from commands/engine.js roster (installed only).
function assignEngines(staffed, engines) {
  const pool = (engines || []).filter(Boolean);
  if (!pool.length) return [];
  return staffed.map((entry, i) => ({ ...entry, engine: pool[i % pool.length] }));
}

// ---------------------------------------------------------------------------
// T3 — serial landing lane

// Land one arrival: rebase onto latest base first; a conflict pauses the
// landing (never auto-resolve) and reports which files collided so the
// conductor or a human can take it. `git` is injectable for tests.
// Ship failures print the cause first (MODULE_NOT_FOUND, command name) and a
// long node stack after. Tail-only clips hide the cause; keep a head+tail.
function headTail(str, head = 400, tail = 500) {
  const s = String(str || '');
  if (s.length <= head + tail) return s;
  return `${s.slice(0, head)} … ${s.slice(-tail)}`;
}

function clipHeadTail(text, { head = 400, tail = 500 } = {}) {
  return headTail(text, head, tail);
}

function dispatchResultToTerminal(entry = {}, result = {}) {
  const payload = {
    engine: result.engine || entry.engine || '',
    task: entry.taskId || (entry.task && entry.task.display_id) || '',
    exit_code: dispatchResultExitCode(result),
    timed_out: Boolean(result.timed_out),
    cancelled: Boolean(result.cancelled),
    stdout: [result.report, result.stdout].map((value) => String(value || '')).join('\n'),
    stderr: result.stderr || '',
  };
  payload.reason = engineTerminalReason(payload);
  payload.ok = payload.reason === 'ok';
  return payload;
}

// Fleet landings always target master. Without the explicit --target, ship
// falls back to the launcher branch's atris-base — a flight launched from a
// feature-branch checkout would merge PRs into that branch while the receipt
// and land board define "landed" as in-master (PRs #207/#208, 2026-07-04).
// A ship failure must name its real cause. MODULE_NOT_FOUND from the spawned
// CLI is usually transient: the fleet ships by spawning node against this
// live checkout, and a concurrent rebase/pull can make a require vanish for a
// moment. So the ship retries once on that signature, and the failure detail
// always surfaces the missing-module line from either stream instead of
// letting head/tail clipping truncate it away (cost measured live: CLI-1185
// receipts kept only a loader stack tail and the module name was lost).
function shipWithRetry(cli, args, cwd) {
  let shipped = cli(args, cwd);
  if (shipped.status !== 0 && /MODULE_NOT_FOUND|Cannot find module/.test(`${shipped.stderr}${shipped.stdout}`)) {
    shipped = cli(args, cwd);
    shipped.retried_module_not_found = true;
  }
  return shipped;
}

function shipFailureDetail(shipped, { head = 400, tail = 500 } = {}) {
  const combined = `${shipped.stderr || ''}\n${shipped.stdout || ''}`;
  const moduleLine = combined.match(/Cannot find module '[^']+'[^\n]*/);
  const cause = moduleLine ? `${moduleLine[0]}${shipped.retried_module_not_found ? ' (persisted after one retry)' : ''}\n` : '';
  return `${cause}${headTail(combined.trim(), head, tail)}`;
}

function fleetShipArgs(entry, check) {
  return [
    'worktree', 'ship',
    '--message', `${String(entry.task.title || '').split(/[.:]/)[0].slice(0, 90)} (${entry.task.display_id}, built by ${entry.engine})`,
    '--verify', check,
    '--target', 'origin/master',
    '--merge',
  ];
}

// A fleet build worktree is ephemeral. If any process inside one runs
// `npm link` (which repoints the global `atris` package symlink at that
// worktree), then removing the worktree at teardown leaves the global `atris`
// binary a dangling symlink, and everything resolving `atris` through PATH —
// interactive shells, any tooling that shells out to the bare command — dies
// with 'command not found'. Measured scope, not assumed: crons that invoke
// `node <checkout>/bin/atris.js` by absolute path are UNAFFECTED; an autoland
// tick ran fine four minutes before the repair. The failure is silent and
// reads like a shell/PATH problem, not a worktree-cleanup one (found live
// 2026-07-26, CLI-1193; same shape as the cron PATH wedge that cost 20 days
// of autoland).
// Recovery was one line: repoint the global link at the real checkout. So
// teardown does exactly that on its own: if the global `atris` link points
// into one of this flight's worktrees, repoint it at the primary checkout and
// verify the CLI still runs before the flight reports success.
function defaultReadGlobalCliLink() {
  const rootResult = spawnSync('npm', ['root', '-g'], { encoding: 'utf8' });
  if (rootResult.status !== 0) return null;
  const globalRoot = String(rootResult.stdout || '').trim();
  if (!globalRoot) return null;
  const pkgPath = path.join(globalRoot, 'atris');
  let stat;
  try {
    stat = fs.lstatSync(pkgPath);
  } catch {
    return null; // atris is not installed globally at all
  }
  if (!stat.isSymbolicLink()) return { path: pkgPath, target: null }; // real install, not a link
  return { path: pkgPath, target: path.resolve(path.dirname(pkgPath), fs.readlinkSync(pkgPath)) };
}

function defaultRepointGlobalCliLink(primaryCheckout) {
  // `npm link` from the real checkout re-creates the global symlink pointing at it.
  return spawnSync('npm', ['link'], { cwd: primaryCheckout, encoding: 'utf8' });
}

function defaultVerifyCliRuns() {
  const result = spawnSync('atris', ['--version'], { encoding: 'utf8' });
  return { ok: result.status === 0, status: result.status, stdout: String(result.stdout || '').trim() };
}

function guardGlobalCliLink({
  root = process.cwd(),
  worktreePaths = [],
  readGlobalLink = defaultReadGlobalCliLink,
  repointLink = defaultRepointGlobalCliLink,
  verifyCli = defaultVerifyCliRuns,
} = {}) {
  const link = readGlobalLink();
  if (!link || !link.target) return { ok: true, changed: false, reason: 'not_linked' };
  const resolvedTarget = realpathOrResolve(link.target);
  const worktrees = worktreePaths.filter(Boolean).map((wt) => realpathOrResolve(wt));
  // Match the raw string so a worktree already removed by ship still matches
  // (its path is gone from disk but the dangling link still names it).
  const insideWorktree = worktrees.some((wt) => resolvedTarget === wt || resolvedTarget.startsWith(`${wt}${path.sep}`));
  if (!insideWorktree) return { ok: true, changed: false, reason: 'healthy', target: link.target };
  let primaryPath = root;
  try {
    primaryPath = listWorktrees(root)[0]?.path || root;
  } catch {
    primaryPath = root;
  }
  const primary = realpathOrResolve(primaryPath);
  const repoint = repointLink(primary);
  const verify = verifyCli();
  return {
    ok: Boolean(verify && verify.ok),
    changed: true,
    reason: 'linked_into_worktree',
    was: link.target,
    restoredTo: primary,
    repoint: { status: repoint ? repoint.status : null },
    verify,
  };
}

// One-line " (path, path)" suffix naming the files behind a paused landing —
// unmerged files for a rebase_conflict, uncommitted paths for a dirty_worktree.
function pausedPathsSuffix(landed) {
  const paths = (landed && landed.conflicts) || (landed && landed.dirty) || [];
  return paths.length ? ` (${paths.join(', ')})` : '';
}

function landArrival({ worktreePath, git = null }) {
  const run = git || ((args) => spawnSync('git', args, { cwd: worktreePath, encoding: 'utf8' }));
  const fetch = run(['fetch', 'origin']);
  if (fetch.status !== 0) return { ok: false, stage: 'fetch', detail: String(fetch.stderr || '').trim() };
  const rebase = run(['rebase', 'origin/master']);
  if (rebase.status !== 0) {
    const conflicts = String(run(['diff', '--name-only', '--diff-filter=U']).stdout || '')
      .trim().split('\n').filter(Boolean);
    run(['rebase', '--abort']);
    // git rebase refuses outright when the worktree has uncommitted changes:
    // it stops before a single conflict can occur, so the unmerged-file list is
    // empty. Reporting an empty list as rebase_conflict sends the operator
    // chasing a merge problem that does not exist while intact work sits
    // uncommitted in the worktree (CLI-1190; hit live on WEB-455 2026-07-25
    // after a killed engine left modified/untracked files behind). An empty
    // conflicts list is never a conflict: name the dirty paths instead.
    if (!conflicts.length) {
      const dirty = String(run(['status', '--porcelain']).stdout || '')
        .split('\n')
        .map((line) => line.slice(3).trim())
        .filter(Boolean);
      return { ok: false, stage: 'dirty_worktree', dirty };
    }
    return { ok: false, stage: 'rebase_conflict', conflicts };
  }
  return { ok: true, stage: 'rebased' };
}

module.exports = {
  DENIED_TAGS,
  DEAD_ENGINE_OUTPUT_PATTERNS,
  releasePausedClaimsWithoutWork,
  reviewOnlyEngineEnvironment,
  runInReapedProcessGroup,
  shipWithRetry,
  shipFailureDetail,
  get FLEET_CAPABLE() { return FLEET_CAPABLE; },
  get DISPATCH_CAPABLE() { return DISPATCH_CAPABLE; },
  get runFleetFlight() { return runFleetFlight; },
  get focusedCheck() { return focusedCheck; },
  get dispatchCheck() { return dispatchCheck; },
  get runDispatchFlight() { return runDispatchFlight; },
  get prepareReviewSandbox() { return prepareReviewSandbox; },
  YOLO_ENGINE_FLAGS,
  DISPATCH_SELF_LAND_TARGET,
  resolveDispatchLandTarget,
  parseDoneCheck,
  METHOD_KERNEL,
  ATRIS_BUILD_PROCESS_PREAMBLE,
  buildFleetPrompt,
  assertIsolatedWorktree,
  buildEngineCommand,
  isSafeLane,
  taskTags,
  nextInstalledFleetEngine,
  rankFleetEnginesDetailed,
  dispatchToEngine,
  taskTags,
  isHumanHoldTag,
  isDecisionTask,
  DECISION_REFUSE_REASON,
  isSafeLane,
  staffFlight,
  assignEngines,
  landArrival,
  detectDeadEngineDispatch,
  dispatchResultToTerminal,
  failedDispatchLeg,
  fleetShipArgs,
  headTail,
  clipHeadTail,
  guardGlobalCliLink,
  defaultSelfLandCheck,
};

// ---------------------------------------------------------------------------
// T4 — the conductor: one flight, watchable, receipted

// Engines that can edit a repo headlessly. atris-fast (ax) is a chat lane,
// not a repo worker — it keeps owning normal mission ticks, not fleet builds.
const FLEET_CAPABLE = ['claude', 'codex', 'cursor', 'devin', 'grok'];
const DISPATCH_CAPABLE = [...FLEET_CAPABLE, 'fable', 'commandcode'];

let receiptSequence = 0;
function nowStamp() {
  receiptSequence += 1;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, '');
  return `${stamp}-p${process.pid}-${receiptSequence}`;
}

function shellSingleQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function canonicalPath(value) {
  const resolved = path.resolve(String(value || ''));
  try { return fs.realpathSync(resolved); } catch { return resolved; }
}

function seatbeltRule(kind, value) {
  return `(${kind} ${JSON.stringify(canonicalPath(value))})`;
}

function seatbeltAncestors(target) {
  const out = [];
  let current = path.dirname(canonicalPath(target));
  while (current && current !== path.dirname(current)) {
    out.push(current);
    current = path.dirname(current);
  }
  out.push('/');
  return out.reverse();
}

function reviewOnlySandboxProfile({ worktreePath, gitDir, quarantine, runtimeTmp, engine = '', network = false, writable = true }) {
  if (process.platform !== 'darwin' || !fs.existsSync('/usr/bin/sandbox-exec')) {
    throw new Error('review-only execution requires the macOS sandbox-exec isolation backend');
  }
  const home = String(process.env.HOME || '').trim();
  const readSubpaths = [
    '/System', '/usr', '/bin', '/sbin', '/Library', '/opt/homebrew', '/dev',
    '/private/etc', '/private/var/db', '/private/var/run', '/private/var/select',
    worktreePath, gitDir, quarantine, runtimeTmp,
  ];
  const writeSubpaths = ['/dev', runtimeTmp];
  if (writable) writeSubpaths.push(worktreePath, gitDir, quarantine);
  const installByEngine = {
    codex: ['.bun'],
    claude: ['.local/bin', '.local/share/claude'],
    cursor: ['.local/bin', '.local/share/cursor-agent'],
    devin: ['.local/bin', '.local/share/devin'],
    grok: ['.local/bin', '.grok/downloads'],
  };
  if (home && engine) {
    for (const relative of installByEngine[engine] || []) readSubpaths.push(path.join(home, relative));
  }
  if (engine && RUNNER_PROFILE_DEFS[engine]) {
    const engineBin = String(RUNNER_PROFILE_DEFS[engine].bin || '').trim();
    const located = engineBin
      ? spawnSync('/bin/sh', ['-c', `command -v ${engineBin}`], { encoding: 'utf8' })
      : null;
    const executable = located && located.status === 0 ? String(located.stdout || '').trim() : '';
    if (executable) {
      readSubpaths.push(path.dirname(executable));
      readSubpaths.push(path.dirname(canonicalPath(executable)));
    }
  }
  const readLiterals = [];
  const writeLiterals = [];
  for (const [key, value] of Object.entries(process.env)) {
    if (!/^ATRIS_(?:ENGINE|VALIDATOR|PUSH|BOUNDARY)_(?:COUNT|PROMPT|RESULT|URL|CONFIG|DUMP)$/.test(key)) continue;
    if (!value || !path.isAbsolute(value)) continue;
    readLiterals.push(value);
    writeLiterals.push(value);
  }
  const ancestorLiterals = [...new Set([
    ...readSubpaths,
    ...readLiterals,
    ...writeLiterals,
  ].flatMap(seatbeltAncestors))];
  const readRules = [
    ...ancestorLiterals.map((value) => seatbeltRule('literal', value)),
    ...[...new Set(readSubpaths)].map((value) => seatbeltRule('subpath', value)),
    ...[...new Set(readLiterals)].map((value) => seatbeltRule('literal', value)),
  ];
  const writeRules = [
    ...[...new Set(writeSubpaths)].map((value) => seatbeltRule('subpath', value)),
    ...[...new Set(writeLiterals)].map((value) => seatbeltRule('literal', value)),
  ];
  return [
    '(version 1)',
    '(deny default)',
    '(import "system.sb")',
    '(import "com.apple.corefoundation.sb")',
    '(allow process*)',
    '(allow signal (target same-sandbox))',
    ...(network ? ['(allow network*)'] : []),
    '(allow sysctl-read)',
    '(allow mach-lookup)',
    '(allow ipc-posix*)',
    `(allow file-read* ${readRules.join(' ')})`,
    `(allow file-write* ${writeRules.join(' ')})`,
  ].join('\n');
}

function prepareEphemeralEngineHome(runtimeTmp, engine) {
  const sourceHome = String(process.env.HOME || '').trim();
  const runtimeHome = path.join(runtimeTmp, `home-${engine || 'verifier'}`);
  fs.mkdirSync(runtimeHome, { recursive: true, mode: 0o700 });
  const copy = (sourceRelative, targetRelative, pickKeys = null) => {
    if (!sourceHome) return;
    const source = path.join(sourceHome, sourceRelative);
    if (!fs.existsSync(source) || !fs.lstatSync(source).isFile()) return;
    const target = path.join(runtimeHome, targetRelative);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    if (pickKeys) {
      let parsed;
      try { parsed = JSON.parse(fs.readFileSync(source, 'utf8')); } catch { return; }
      const selected = {};
      for (const key of pickKeys) {
        if (Object.prototype.hasOwnProperty.call(parsed, key)) selected[key] = parsed[key];
      }
      fs.writeFileSync(target, `${JSON.stringify(selected, null, 2)}\n`, { mode: 0o600 });
    } else {
      fs.copyFileSync(source, target);
      fs.chmodSync(target, 0o600);
    }
  };
  if (engine === 'codex') copy('.codex/auth.json', '.codex/auth.json');
  if (engine === 'claude') {
    copy('.claude.json', '.claude.json', [
      'oauthAccount', 'userID', 'anonymousId', 'machineID', 'hasCompletedOnboarding',
      'installMethod', 'claudeMaxTier', 'hasAvailableMaxSubscription', 'hasAvailableSubscription',
    ]);
  }
  if (engine === 'cursor') {
    copy('.cursor/cli-config.json', '.cursor/cli-config.json', ['authInfo', 'version', 'privacyCache', 'network']);
  }
  if (engine === 'devin') copy('.config/devin/config.json', '.config/devin/config.json');
  if (engine === 'grok') {
    copy('.grok/auth.json', '.grok/auth.json');
    copy('.grok/config.toml', '.grok/config.toml');
  }
  return runtimeHome;
}

function reviewOnlyEngineEnvironment(worktreePath, options = {}) {
  const selectedEngine = String(options.engine || '');
  const selectedSecret = (engines, name) => engines.includes(selectedEngine) ? String(process.env[name] || '') : '';
  const runtimeTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-one-lap-runtime-'));
  const guardDir = path.join(runtimeTmp, 'bin');
  fs.mkdirSync(guardDir, { recursive: true });
  const locate = (name) => {
    const result = spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' });
    return result.status === 0 ? String(result.stdout || '').trim() : '';
  };
  const gitBin = locate('git');
  if (!gitBin) throw new Error('review-only dispatch requires git');
  fs.writeFileSync(path.join(guardDir, 'git'), [
    '#!/bin/sh',
    'for arg in "$@"; do',
    '  case "$arg" in',
    '    push|send-pack) echo "one lap blocked git $arg" >&2; exit 2 ;;',
    '  esac',
    'done',
    `exec ${shellSingleQuote(gitBin)} "$@"`,
    '',
  ].join('\n'), { mode: 0o755 });

  const npmBin = locate('npm');
  if (npmBin) {
    fs.writeFileSync(path.join(guardDir, 'npm'), [
      '#!/bin/sh',
      'case "${1:-}" in',
      '  publish|install|i|add|login|logout|owner|token|deprecate|unpublish|dist-tag|access|team|org) echo "one lap blocked npm $1" >&2; exit 2 ;;',
      'esac',
      `exec ${shellSingleQuote(npmBin)} "$@"`,
      '',
    ].join('\n'), { mode: 0o755 });
  }

  for (const command of ['gh', 'curl', 'wget', 'ssh', 'scp', 'rsync', 'fly', 'flyctl', 'vercel', 'render', 'kubectl', 'aws', 'gcloud', 'az', 'terraform', 'stripe']) {
    fs.writeFileSync(path.join(guardDir, command), `#!/bin/sh\necho "one lap blocked ${command}" >&2\nexit 2\n`, { mode: 0o755 });
  }
  const commonResult = spawnSync('git', ['rev-parse', '--git-common-dir'], { cwd: worktreePath, encoding: 'utf8' });
  const remoteResult = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: worktreePath, encoding: 'utf8' });
  if (commonResult.status !== 0 || remoteResult.status !== 0) {
    throw new Error('review-only execution could not resolve its sealed Git boundary');
  }
  const gitDir = canonicalPath(path.resolve(worktreePath, String(commonResult.stdout || '').trim()));
  const quarantine = canonicalPath(path.resolve(worktreePath, String(remoteResult.stdout || '').trim()));
  const runtimeHome = prepareEphemeralEngineHome(runtimeTmp, selectedEngine);
  const controlTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-one-lap-control-'));
  const lifecycle = sandboxLifecycleWrapper(runtimeTmp, controlTmp);
  let sandboxProfile;
  try {
    sandboxProfile = reviewOnlySandboxProfile({
      worktreePath,
      gitDir,
      quarantine,
      runtimeTmp,
      engine: String(options.engine || ''),
      network: options.network === true,
      writable: options.writable !== false,
    });
  } catch (error) {
    fs.rmSync(runtimeTmp, { recursive: true, force: true });
    fs.rmSync(controlTmp, { recursive: true, force: true });
    throw error;
  }
  const environment = {
    PATH: `${guardDir}${path.delimiter}${process.env.PATH || ''}`,
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'remote.origin.pushurl',
    GIT_CONFIG_VALUE_0: path.join(guardDir, 'blocked-push'),
    GIT_CONFIG_KEY_1: 'remote.origin.receivepack',
    GIT_CONFIG_VALUE_1: 'false',
    GH_TOKEN: '',
    GITHUB_TOKEN: '',
    NPM_TOKEN: '',
    NODE_AUTH_TOKEN: '',
    AWS_ACCESS_KEY_ID: '',
    AWS_SECRET_ACCESS_KEY: '',
    GOOGLE_APPLICATION_CREDENTIALS: '',
    AZURE_CLIENT_SECRET: '',
    STRIPE_SECRET_KEY: '',
    OPENAI_API_KEY: selectedSecret(['codex'], 'OPENAI_API_KEY'),
    CODEX_API_KEY: selectedSecret(['codex'], 'CODEX_API_KEY'),
    // owner policy: claude work runs on the subscription login, never API
    // billing, so the api key is stripped even when the parent env has one.
    ANTHROPIC_API_KEY: '',
    CLAUDE_CODE_OAUTH_TOKEN: selectedSecret(['claude'], 'CLAUDE_CODE_OAUTH_TOKEN'),
    CURSOR_API_KEY: selectedSecret(['cursor'], 'CURSOR_API_KEY'),
    DEVIN_API_KEY: selectedSecret(['devin'], 'DEVIN_API_KEY'),
    XAI_API_KEY: selectedSecret(['grok'], 'XAI_API_KEY'),
    GROK_API_KEY: selectedSecret(['grok'], 'GROK_API_KEY'),
    SSH_AUTH_SOCK: '',
    TMPDIR: runtimeTmp,
    HOME: runtimeHome,
    XDG_CONFIG_HOME: path.join(runtimeHome, '.config'),
    XDG_CACHE_HOME: path.join(runtimeTmp, 'cache'),
    npm_config_cache: path.join(runtimeTmp, 'npm-cache'),
    GIT_CONFIG_GLOBAL: path.join(runtimeTmp, 'gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    CODEX_HOME: path.join(runtimeHome, '.codex'),
    CLAUDE_CONFIG_DIR: path.join(runtimeHome, '.claude'),
    ATRIS_ONE_LAP_SANDBOX_PROFILE: sandboxProfile,
    ATRIS_ONE_LAP_RUNTIME_DIR: runtimeTmp,
    ATRIS_ONE_LAP_CONTROL_DIR: controlTmp,
    ATRIS_ONE_LAP_LIFECYCLE_WRAPPER: lifecycle.wrapper,
    ATRIS_ONE_LAP_STATUS_FILE: lifecycle.statusFile,
  };
  const inheritKeys = [
    'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'NO_COLOR', 'USER', 'LOGNAME', 'SHELL',
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
    'NODE_EXTRA_CA_CERTS', 'NODE_NO_WARNINGS', 'DISABLE_AUTOUPDATER',
    'ATRIS_ENGINE_MODE', 'ATRIS_ENGINE_DELAY', 'ATRIS_ENGINE_COUNT', 'ATRIS_ENGINE_PROMPT',
    'ATRIS_VALIDATOR_MODE', 'ATRIS_VALIDATOR_COUNT', 'ATRIS_VALIDATOR_PROMPT',
    'ATRIS_PUSH_RESULT', 'ATRIS_PUSH_URL', 'ATRIS_PUSH_CONFIG', 'ATRIS_BOUNDARY_DUMP',
    'ATRIS_REAL_GIT', 'ATRIS_TASKS_DB',
  ];
  for (const key of inheritKeys) {
    if (process.env[key] !== undefined) environment[key] = String(process.env[key]);
  }
  if (options.secretGrant) {
    const grantOptions = {};
    if (options.secretGrantUpstreamPort !== undefined) grantOptions.upstreamPort = options.secretGrantUpstreamPort;
    if (options.secretGrantUpstreamAddress !== undefined) grantOptions.upstreamAddress = options.secretGrantUpstreamAddress;
    if (options.secretGrantRejectUnauthorized !== undefined) {
      grantOptions.rejectUnauthorized = options.secretGrantRejectUnauthorized;
    }
    applySecretGrantEnvironment(environment, options.secretGrant, grantOptions);
    for (const key of SECRET_GATEWAY_PROXY_ENV_KEYS) {
      if (key.toUpperCase() === 'NO_PROXY') environment[key] = '127.0.0.1,localhost';
      else environment[key] = '';
    }
  }
  return environment;
}

function conductorGitEnvironment() {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  for (const key of Object.keys(env)) {
    if (/^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+)$/.test(key)) delete env[key];
  }
  for (const key of [
    'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_REPLACE_REF_BASE', 'GIT_GRAFT_FILE', 'GIT_CONFIG_PARAMETERS',
  ]) delete env[key];
  return env;
}

function remoteMasterOid(worktreePath, remote = 'origin') {
  const result = spawnSync('git', ['ls-remote', '--exit-code', remote, 'refs/heads/master'], {
    cwd: worktreePath,
    encoding: 'utf8',
    timeout: 15000,
    env: conductorGitEnvironment(),
  });
  if (result.status !== 0) return '';
  return String(result.stdout || '').trim().split(/\s+/)[0] || '';
}

function remoteRefsDigest(worktreePath, remote = 'origin') {
  const result = spawnSync('git', ['ls-remote', remote], {
    cwd: worktreePath,
    encoding: 'utf8',
    timeout: 30000,
    env: conductorGitEnvironment(),
  });
  if (result.status !== 0) return '';
  return crypto.createHash('sha256').update(String(result.stdout || '')).digest('hex');
}

function digestFiles(paths) {
  const hash = crypto.createHash('sha256');
  const visit = (target) => {
    hash.update(`\0${target}\0`);
    if (!fs.existsSync(target)) {
      hash.update('missing');
      return;
    }
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) {
      hash.update(`link:${fs.readlinkSync(target)}`);
      return;
    }
    if (stat.isDirectory()) {
      hash.update('directory');
      for (const name of fs.readdirSync(target).sort()) visit(path.join(target, name));
      return;
    }
    hash.update(`file:${stat.mode}:`);
    hash.update(fs.readFileSync(target));
  };
  for (const target of paths) visit(target);
  return hash.digest('hex');
}

function reviewSandboxMetadataDigest(boundary) {
  return digestFiles([
    path.join(boundary.worktreePath, '.git'),
    path.join(boundary.gitDir, 'config'),
    path.join(boundary.gitDir, 'hooks'),
    path.join(boundary.gitDir, 'info'),
    path.join(boundary.gitDir, 'objects', 'info'),
    path.join(boundary.gitDir, 'shallow'),
    path.join(boundary.worktreeGitDir, 'config.worktree'),
    path.join(boundary.worktreeGitDir, 'commondir'),
    path.join(boundary.worktreeGitDir, 'gitdir'),
    path.join(boundary.worktreeGitDir, 'HEAD'),
  ]);
}

function bareRefsDigest(gitDir) {
  const result = spawnSync('git', ['--git-dir', gitDir, 'show-ref', '--head'], { encoding: 'utf8', env: trustedGitEnvironment() });
  if (result.status !== 0) return '';
  return crypto.createHash('sha256').update(String(result.stdout || '')).digest('hex');
}

function prepareReviewSandbox({ root, taskId, engine }) {
  const run = (args, options = {}) => spawnSync('git', args, {
    cwd: options.cwd || root,
    encoding: 'utf8',
    env: trustedGitEnvironment(),
    timeout: options.timeout || 30000,
  });
  const runConductorGit = (args) => spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    env: conductorGitEnvironment(),
    timeout: 30000,
  });
  // `git` walks up to the nearest enclosing repository when `root` is not itself
  // a git checkout. Without this guard, review-only dispatch would fetch and
  // trust the origin/master of whatever repo happens to sit above `root`, and
  // build against it. Refuse unless `root` is its own git top level.
  const toplevel = runConductorGit(['rev-parse', '--show-toplevel']);
  if (toplevel.status !== 0
    || realpathOrResolve(String(toplevel.stdout || '').trim()) !== realpathOrResolve(root)) {
    return { ok: false, detail: 'review-only dispatch requires the workspace to be its own git repository' };
  }
  const fetched = runConductorGit(['fetch', 'origin', 'master']);
  const original = runConductorGit(['remote', 'get-url', 'origin']);
  const base = run(['rev-parse', '--verify', 'origin/master^{commit}']);
  if (fetched.status !== 0 || original.status !== 0 || base.status !== 0) {
    return { ok: false, detail: 'review-only dispatch requires a current protected origin/master' };
  }
  const originalUrl = String(original.stdout || '').trim();
  const protectedMaster = remoteMasterOid(root, originalUrl);
  const protectedRefs = remoteRefsDigest(root, originalUrl);
  const baseOid = String(base.stdout || '').trim();
  if (!protectedMaster || !protectedRefs || baseOid !== protectedMaster) {
    return { ok: false, detail: 'review-only origin/master is not at the protected remote snapshot' };
  }

  const token = `${String(taskId || 'task').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'task'}-${process.pid}-${crypto.randomBytes(5).toString('hex')}`;
  const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), `atris-one-lap-${token}-`));
  const worktreePath = path.join(sandboxRoot, 'worktree');
  const gitDir = path.join(sandboxRoot, 'objects.git');
  const quarantine = path.join(sandboxRoot, 'quarantine.git');
  const seedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-one-lap-seed-'));
  const seedBundle = path.join(seedDir, 'seed.bundle');
  const branch = `one-lap-${token}`;
  const cleanup = () => {
    fs.rmSync(seedDir, { recursive: true, force: true });
    fs.rmSync(worktreePath, { recursive: true, force: true });
    fs.rmSync(gitDir, { recursive: true, force: true });
    fs.rmSync(quarantine, { recursive: true, force: true });
    fs.rmSync(sandboxRoot, { recursive: true, force: true });
  };

  try {
    fs.mkdirSync(sandboxRoot, { recursive: true });
    let result = run(['bundle', 'create', seedBundle, 'origin/master']);
    if (result.status !== 0) throw new Error(String(result.stderr || result.stdout || 'could not create seed bundle').trim());
    result = run(['init', '--bare', '--initial-branch=master', gitDir], { cwd: sandboxRoot });
    if (result.status !== 0) throw new Error(String(result.stderr || result.stdout || 'could not initialize sandbox object store').trim());
    result = spawnSync('git', ['--git-dir', gitDir, 'bundle', 'unbundle', seedBundle], { encoding: 'utf8', timeout: 30000 });
    if (result.status !== 0) throw new Error(String(result.stderr || result.stdout || 'could not seed sandbox object store').trim());
    result = run(['init', '--bare', '--initial-branch=master', quarantine], { cwd: sandboxRoot });
    if (result.status !== 0) throw new Error(String(result.stderr || result.stdout || 'could not initialize quarantine remote').trim());
    result = spawnSync('git', ['--git-dir', quarantine, 'bundle', 'unbundle', seedBundle], { encoding: 'utf8', timeout: 30000 });
    if (result.status !== 0) throw new Error(String(result.stderr || result.stdout || 'could not seed quarantine remote').trim());
    for (const [repo, ref, oid] of [
      [gitDir, `refs/heads/${branch}`, baseOid],
      [gitDir, 'refs/remotes/origin/master', baseOid],
      [quarantine, 'refs/heads/master', baseOid],
    ]) {
      result = spawnSync('git', ['--git-dir', repo, 'update-ref', ref, oid], { encoding: 'utf8' });
      if (result.status !== 0) throw new Error(String(result.stderr || `could not seed ${ref}`).trim());
    }
    const configure = (args) => spawnSync('git', ['--git-dir', gitDir, 'config', ...args], { encoding: 'utf8' });
    for (const args of [
      ['extensions.worktreeConfig', 'true'],
      ['remote.origin.url', quarantine],
      ['remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'],
      ['user.name', String(runConductorGit(['config', '--get', 'user.name']).stdout || 'Atris One Lap').trim() || 'Atris One Lap'],
      ['user.email', String(runConductorGit(['config', '--get', 'user.email']).stdout || 'one-lap@localhost').trim() || 'one-lap@localhost'],
    ]) {
      result = configure(args);
      if (result.status !== 0) throw new Error(String(result.stderr || 'could not configure sandbox').trim());
    }
    result = spawnSync('git', ['--git-dir', gitDir, 'worktree', 'add', '--no-checkout', worktreePath, branch], {
      encoding: 'utf8',
      env: trustedGitEnvironment(),
      timeout: 30000,
    });
    if (result.status !== 0) throw new Error(String(result.stderr || result.stdout || 'could not create sandbox worktree').trim());
    result = spawnSync('git', ['-C', worktreePath, 'config', '--worktree', 'core.bare', 'false'], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(String(result.stderr || 'could not activate sandbox worktree').trim());
    const worktreeGitDirResult = spawnSync('git', ['-C', worktreePath, 'rev-parse', '--absolute-git-dir'], { encoding: 'utf8' });
    if (worktreeGitDirResult.status !== 0) throw new Error(String(worktreeGitDirResult.stderr || 'could not locate sandbox worktree metadata').trim());
    const worktreeGitDir = String(worktreeGitDirResult.stdout || '').trim();
    result = spawnSync('git', ['-C', worktreePath, 'read-tree', 'HEAD'], { encoding: 'utf8', env: trustedGitEnvironment() });
    if (result.status !== 0) throw new Error(String(result.stderr || 'could not seed sandbox index').trim());
    materializeVerifiedTree(worktreePath, [], readGitTree(gitDir, baseOid));
    fs.mkdirSync(path.join(worktreePath, '.atris'), { recursive: true });
    fs.writeFileSync(path.join(worktreePath, '.atris', 'agent-worktree.json'), `${JSON.stringify({
      agent: engine || null,
      owner: engine || 'one-lap',
      task: String(taskId || ''),
      branch,
      base: 'origin/master',
      sealed_review_sandbox: true,
      created_at: new Date().toISOString(),
    }, null, 2)}\n`, 'utf8');
    fs.rmSync(seedDir, { recursive: true, force: true });

    const boundary = {
      ok: true,
      trustedRoot: root,
      sandboxRoot,
      worktreePath,
      gitDir,
      worktreeGitDir,
      quarantine,
      originalUrl,
      protectedMaster,
      protectedRefs,
      quarantineRefs: bareRefsDigest(quarantine),
      branch,
      baseOid,
    };
    boundary.metadataDigest = reviewSandboxMetadataDigest(boundary);
    const configText = fs.readFileSync(path.join(gitDir, 'config'), 'utf8');
    const gitFile = fs.readFileSync(path.join(worktreePath, '.git'), 'utf8');
    if (!boundary.quarantineRefs || configText.includes(originalUrl) || configText.includes(root) || gitFile.includes(root)) {
      throw new Error('sealed sandbox leaked a protected repository locator');
    }
    return boundary;
  } catch (error) {
    cleanup();
    return { ok: false, detail: `review-only sandbox could not be prepared: ${error.message}` };
  }
}

function reviewRemoteBoundaryState(worktreePath, boundary) {
  if (!boundary || !boundary.ok) {
    return { ok: false, stage: 'remote_quarantine', detail: 'review-only sealed sandbox is not armed' };
  }
  let metadataDigest = '';
  try { metadataDigest = reviewSandboxMetadataDigest(boundary); } catch {}
  if (!metadataDigest || metadataDigest !== boundary.metadataDigest) {
    return {
      ok: false,
      stage: 'sandbox_metadata_changed',
      detail: 'the worker changed sealed Git metadata',
      protected_master: boundary.protectedMaster,
    };
  }
  const protectedMaster = remoteMasterOid(boundary.trustedRoot, boundary.originalUrl);
  const protectedRefs = remoteRefsDigest(boundary.trustedRoot, boundary.originalUrl);
  const quarantineMasterResult = spawnSync('git', ['--git-dir', boundary.quarantine, 'rev-parse', '--verify', 'refs/heads/master^{commit}'], { encoding: 'utf8' });
  const quarantineMaster = quarantineMasterResult.status === 0 ? String(quarantineMasterResult.stdout || '').trim() : '';
  const quarantineRefs = bareRefsDigest(boundary.quarantine);
  if (!protectedMaster || !protectedRefs || protectedMaster !== boundary.protectedMaster || protectedRefs !== boundary.protectedRefs) {
    return {
      ok: false,
      stage: 'master_changed',
      detail: 'the protected remote changed during isolated execution',
      protected_master: protectedMaster || null,
    };
  }
  if (!quarantineMaster || !quarantineRefs || quarantineMaster !== boundary.protectedMaster || quarantineRefs !== boundary.quarantineRefs) {
    return {
      ok: false,
      stage: 'outbound_attempt',
      detail: 'the worker attempted to change the quarantined remote',
      protected_master: protectedMaster,
    };
  }
  return { ok: true, protected_master: protectedMaster };
}

function reviewCandidateSnapshot(boundary, expected = null) {
  const fail = (detail, extra = {}) => ({ ok: false, stage: 'candidate_changed', detail, ...extra });
  const run = (args) => spawnSync('git', args, {
    cwd: boundary.worktreePath,
    encoding: 'utf8',
    env: trustedGitEnvironment(),
    timeout: 30000,
  });
  const firstHead = run(['rev-parse', '--verify', 'HEAD^{commit}']);
  const tree = run(['rev-parse', '--verify', 'HEAD^{tree}']);
  const status = run(['status', '--porcelain=v1', '--untracked-files=all']);
  const secondHead = run(['rev-parse', '--verify', 'HEAD^{commit}']);
  const failed = [firstHead, tree, status, secondHead].find((result) => result.status !== 0);
  if (failed) return fail(String(failed.stderr || failed.stdout || 'could not freeze the executor candidate').trim());
  const commit = String(firstHead.stdout || '').trim();
  const repeatedCommit = String(secondHead.stdout || '').trim();
  const treeOid = String(tree.stdout || '').trim();
  if (commit !== repeatedCommit) return fail('the executor changed HEAD while its candidate was being frozen');
  const dirty = String(status.stdout || '').trim().split(/\r?\n/).filter(Boolean)
    .filter((line) => !isConductorStatusLine(line));
  if (dirty.length) return fail(`the executor left uncommitted changes: ${dirty.slice(0, 10).join(', ')}`);
  if (expected && (commit !== expected.commit || treeOid !== expected.tree)) {
    return fail('the sealed candidate changed after the executor exited', { commit, tree: treeOid });
  }
  return { ok: true, stage: 'candidate_frozen', commit, tree: treeOid };
}

function trustedGitEnvironment() {
  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_ATTR_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
  };
  for (const key of Object.keys(env)) {
    if (/^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+)$/.test(key)) delete env[key];
  }
  for (const key of [
    'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_REPLACE_REF_BASE', 'GIT_GRAFT_FILE', 'GIT_CONFIG_PARAMETERS',
  ]) delete env[key];
  return env;
}

function readGitTree(gitDir, ref) {
  const env = trustedGitEnvironment();
  const listed = spawnSync('git', ['--git-dir', gitDir, 'ls-tree', '-rz', '--full-tree', ref], {
    encoding: 'utf8',
    env,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (listed.status !== 0) throw new Error(String(listed.stderr || 'could not read verified tree').trim());
  const entries = String(listed.stdout || '').split('\0').filter(Boolean).map((line) => {
    const match = line.match(/^([0-7]{6}) (blob|commit) ([0-9a-f]{40,64})\t([^]*)$/);
    if (!match) throw new Error('verified tree contains an unreadable entry');
    const [, mode, type, oid, relative] = match;
    if (type !== 'blob' || !['100644', '100755', '120000'].includes(mode)) {
      throw new Error(`verified tree entry is not a regular file or symlink: ${relative}`);
    }
    if (path.isAbsolute(relative) || relative.split('/').some((part) => !part || part === '.' || part === '..')) {
      throw new Error(`verified tree contains an unsafe path: ${relative}`);
    }
    if (!/^[\x20-\x7e]+$/.test(relative)) {
      throw new Error(`verified tree contains a non-ASCII path that cannot be imported safely: ${relative}`);
    }
    const folded = relative.toLowerCase();
    if (folded === '.atris' || folded === '.atris/agent-worktree.json' || folded === '.git' || folded.startsWith('.git/')) {
      throw new Error('verified tree conflicts with Atris worktree metadata');
    }
    return { mode, oid, relative };
  });
  const uniqueOids = [...new Set(entries.map((entry) => entry.oid))];
  const batch = spawnSync('git', ['--git-dir', gitDir, 'cat-file', '--batch'], {
    encoding: null,
    env,
    input: `${uniqueOids.join('\n')}\n`,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (batch.status !== 0) throw new Error(String(batch.stderr || 'could not read verified blobs').trim());
  const blobs = new Map();
  let offset = 0;
  for (const requestedOid of uniqueOids) {
    const newline = batch.stdout.indexOf(0x0a, offset);
    if (newline === -1) throw new Error('verified blob batch ended before its header');
    const header = batch.stdout.subarray(offset, newline).toString('utf8').split(/\s+/);
    const size = Number(header[2]);
    if (header[0] !== requestedOid || header[1] !== 'blob' || !Number.isSafeInteger(size) || size < 0) {
      throw new Error('verified blob batch returned an invalid object');
    }
    const start = newline + 1;
    const end = start + size;
    if (end >= batch.stdout.length || batch.stdout[end] !== 0x0a) throw new Error('verified blob batch returned a truncated object');
    blobs.set(requestedOid, Buffer.from(batch.stdout.subarray(start, end)));
    offset = end + 1;
  }
  return entries.map((entry) => ({ ...entry, data: blobs.get(entry.oid) }));
}

function materializeVerifiedTree(landingPath, baseEntries, sourceEntries) {
  const within = (relative) => {
    const absolute = path.resolve(landingPath, relative);
    if (absolute !== landingPath && !absolute.startsWith(`${path.resolve(landingPath)}${path.sep}`)) {
      throw new Error(`verified tree path escapes the landing worktree: ${relative}`);
    }
    return absolute;
  };
  for (const entry of [...baseEntries].sort((a, b) => b.relative.length - a.relative.length)) {
    fs.rmSync(within(entry.relative), { recursive: true, force: true });
  }
  for (const entry of sourceEntries) {
    const target = within(entry.relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.rmSync(target, { recursive: true, force: true });
    if (entry.mode === '120000') {
      fs.symlinkSync(entry.data.toString('utf8'), target);
    } else {
      fs.writeFileSync(target, entry.data, { mode: entry.mode === '100755' ? 0o755 : 0o644 });
      fs.chmodSync(target, entry.mode === '100755' ? 0o755 : 0o644);
    }
  }
  const sourceByPath = new Map(sourceEntries.map((entry) => [entry.relative, entry]));
  for (const entry of sourceEntries) {
    const target = within(entry.relative);
    const stat = fs.lstatSync(target);
    if (entry.mode === '120000') {
      if (!stat.isSymbolicLink() || fs.readlinkSync(target) !== entry.data.toString('utf8')) {
        throw new Error(`materialized symlink does not match verified tree: ${entry.relative}`);
      }
    } else if (!stat.isFile() || !fs.readFileSync(target).equals(entry.data) || Boolean(stat.mode & 0o111) !== (entry.mode === '100755')) {
      throw new Error(`materialized file does not match verified tree: ${entry.relative}`);
    }
  }
  for (const entry of baseEntries) {
    if (!sourceByPath.has(entry.relative) && fs.existsSync(within(entry.relative))) {
      throw new Error(`deleted verified path remains in landing worktree: ${entry.relative}`);
    }
  }
}

function persistVerifiedCommit(boundary, landingPath, headOid) {
  const transferDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-one-lap-proof-'));
  const bundle = path.join(transferDir, 'verified.bundle');
  const proofRef = `refs/atris/one-lap/${headOid}`;
  const env = trustedGitEnvironment();
  try {
    let result = spawnSync('git', ['bundle', 'create', bundle, 'HEAD', `^${boundary.baseOid}`], {
      cwd: boundary.worktreePath,
      encoding: 'utf8',
      env,
      timeout: 60000,
    });
    if (result.status !== 0) throw new Error(String(result.stderr || result.stdout || 'could not export proof objects').trim());
    result = spawnSync('git', ['bundle', 'unbundle', bundle], {
      cwd: landingPath,
      encoding: 'utf8',
      env,
      timeout: 60000,
    });
    if (result.status !== 0) throw new Error(String(result.stderr || result.stdout || 'could not import proof objects').trim());
    result = spawnSync('git', ['update-ref', proofRef, headOid], { cwd: landingPath, encoding: 'utf8', env });
    if (result.status !== 0) throw new Error(String(result.stderr || 'could not retain proof ref').trim());
    result = spawnSync('git', ['cat-file', '-e', `${headOid}^{commit}`], { cwd: landingPath, encoding: 'utf8', env });
    if (result.status !== 0) throw new Error('the retained proof commit is not readable from the review worktree');
    return proofRef;
  } finally {
    fs.rmSync(transferDir, { recursive: true, force: true });
  }
}

function bindOneLapProof(worktreePath, proofRef, sourceCommit) {
  const env = trustedGitEnvironment();
  const branchResult = spawnSync('git', ['branch', '--show-current'], { cwd: worktreePath, encoding: 'utf8', env });
  const treeResult = spawnSync('git', ['rev-parse', '--verify', `${proofRef}^{tree}`], { cwd: worktreePath, encoding: 'utf8', env });
  const branch = String(branchResult.stdout || '').trim();
  const sourceTree = String(treeResult.stdout || '').trim();
  if (branchResult.status !== 0 || !branch || treeResult.status !== 0 || !/^[0-9a-f]{40,64}$/.test(sourceTree)) {
    throw new Error('could not bind the review worktree to its verified proof tree');
  }
  const sidecarPath = path.join(worktreePath, '.atris', 'agent-worktree.json');
  let sidecar;
  try {
    sidecar = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
  } catch {
    throw new Error('could not read review worktree metadata for proof binding');
  }
  sidecar.one_lap_proof = {
    schema: 'atris.one_lap_proof.v1',
    ref: proofRef,
    commit: sourceCommit,
    tree: sourceTree,
  };
  fs.writeFileSync(sidecarPath, `${JSON.stringify(sidecar, null, 2)}\n`, 'utf8');
  const configured = spawnSync('git', ['config', `branch.${branch}.atris-proof-ref`, proofRef], {
    cwd: worktreePath,
    encoding: 'utf8',
    env,
  });
  if (configured.status !== 0) throw new Error(String(configured.stderr || 'could not persist one-lap proof binding').trim());
  return sourceTree;
}

function importReviewCommit(boundary, { cli, taskId, engine, expectedCommit = '', expectedTree = '', startBaseArgs = [] } = {}) {
  const fail = (stage, detail, extra = {}) => ({ ok: false, stage, detail: headTail(String(detail || '').trim()), ...extra });
  const runSandbox = (args) => spawnSync('git', args, {
    cwd: boundary.worktreePath,
    encoding: 'utf8',
    env: trustedGitEnvironment(),
    timeout: 30000,
  });
  const boundaryState = reviewRemoteBoundaryState(boundary.worktreePath, boundary);
  if (!boundaryState.ok) return boundaryState;
  if (!expectedCommit || !expectedTree) return fail('candidate_changed', 'the verified candidate identity was not frozen before import');
  const candidate = reviewCandidateSnapshot(boundary, { commit: expectedCommit, tree: expectedTree });
  if (!candidate.ok) return candidate;
  const status = runSandbox(['status', '--porcelain=v1', '--untracked-files=all']);
  if (status.status !== 0) return fail('review_import', status.stderr || 'could not inspect the sealed sandbox');
  const dirtyEntries = String(status.stdout || '').trim().split(/\r?\n/).filter(Boolean);
  const uncommitted = dirtyEntries.filter((line) => !isConductorStatusLine(line));
  if (uncommitted.length) return fail('uncommitted_change', `the sealed executor must commit every requested change before Review: ${uncommitted.join(', ')}`);
  const headOid = expectedCommit;
  if (headOid === boundary.baseOid) return fail('no_change', 'the executor produced no committed change');
  if (runSandbox(['merge-base', '--is-ancestor', boundary.baseOid, headOid]).status !== 0) {
    return fail('review_import', 'the verified commit is not descended from the protected snapshot');
  }
  const refs = spawnSync('git', ['--git-dir', boundary.gitDir, 'show-ref'], { encoding: 'utf8', env: trustedGitEnvironment() });
  if (refs.status !== 0) return fail('review_import', refs.stderr || 'could not inspect sealed refs');
  const allowedRefs = new Map([
    [`refs/heads/${boundary.branch}`, headOid],
    ['refs/remotes/origin/HEAD', boundary.baseOid],
    ['refs/remotes/origin/master', boundary.baseOid],
  ]);
  const refLines = String(refs.stdout || '').trim().split(/\r?\n/).filter(Boolean);
  const seenRefs = new Set();
  for (const line of refLines) {
    const [oid, ref] = line.split(/\s+/, 2);
    if (!allowedRefs.has(ref) || allowedRefs.get(ref) !== oid) return fail('sandbox_metadata_changed', `the worker created an unexpected Git ref (${ref || 'unknown'})`);
    seenRefs.add(ref);
  }
  for (const ref of [`refs/heads/${boundary.branch}`, 'refs/remotes/origin/master']) {
    if (!seenRefs.has(ref)) return fail('sandbox_metadata_changed', `the sealed sandbox is missing a required Git ref (${ref})`);
  }

  let baseEntries;
  let sourceEntries;
  try {
    baseEntries = readGitTree(boundary.gitDir, boundary.baseOid);
    sourceEntries = readGitTree(boundary.gitDir, headOid);
  } catch (error) {
    return fail('review_import', error.message);
  }
  const baseByPath = new Map(baseEntries.map((entry) => [entry.relative, entry]));
  const sourceByPath = new Map(sourceEntries.map((entry) => [entry.relative, entry]));
  const changedEntries = [...new Set([...baseByPath.keys(), ...sourceByPath.keys()])]
    .filter((relative) => {
      const before = baseByPath.get(relative);
      const after = sourceByPath.get(relative);
      return !before || !after || before.oid !== after.oid || before.mode !== after.mode;
    })
    .sort()
    .map((relative) => `${baseByPath.has(relative) ? (sourceByPath.has(relative) ? 'M' : 'D') : 'A'} ${relative}`);
  if (!changedEntries.length) return fail('no_change', 'the verified commit has no tree change');

  const started = cli(['worktree', 'start', '--agent', engine, '--task', `dispatch-${String(taskId).toLowerCase()}`, ...startBaseArgs]);
  const landingPath = (String(started && started.stdout || '').match(/next: cd (.+)/) || [])[1];
  if (!landingPath) return fail('worktree_start', String(started && (started.stderr || started.stdout) || 'could not create review worktree'));
  const worktreePath = landingPath.trim();
  const landingHead = spawnSync('git', ['rev-parse', '--verify', 'HEAD^{commit}'], {
    cwd: worktreePath,
    encoding: 'utf8',
    env: trustedGitEnvironment(),
  });
  if (landingHead.status !== 0 || String(landingHead.stdout || '').trim() !== boundary.baseOid) {
    return fail('review_import', 'the review worktree was not cut from the verified base', { worktreePath });
  }
  let proofRef;
  let proofTree;
  try {
    proofRef = persistVerifiedCommit(boundary, worktreePath, headOid);
    proofTree = bindOneLapProof(worktreePath, proofRef, headOid);
    materializeVerifiedTree(worktreePath, baseEntries, sourceEntries);
  } catch (error) {
    return fail('review_import', error.message, { worktreePath });
  }
  return {
    ok: true,
    stage: 'verified_for_review',
    worktreePath,
    sourceWorktreePath: boundary.worktreePath,
    head: headOid,
    proof_ref: proofRef,
    proof_tree: proofTree,
    protected_master: boundary.protectedMaster,
    change: {
      has_change: true,
      base: boundary.baseOid,
      head: boundary.baseOid,
      source_commit: headOid,
      proof_ref: proofRef,
      proof_tree: proofTree,
      commit: headOid,
      dirty: true,
      changed_entries: changedEntries.slice(0, 100),
    },
  };
}

function disposeReviewSandbox(boundary) {
  spawnSync('git', ['--git-dir', boundary.gitDir, 'worktree', 'remove', '--force', boundary.worktreePath], { encoding: 'utf8' });
  fs.rmSync(boundary.worktreePath, { recursive: true, force: true });
  fs.rmSync(boundary.gitDir, { recursive: true, force: true });
  fs.rmSync(boundary.quarantine, { recursive: true, force: true });
  fs.rmSync(boundary.sandboxRoot, { recursive: true, force: true });
}

function inspectReviewChange(worktreePath, baseRef = 'origin/master') {
  const run = (args) => spawnSync('git', args, { cwd: worktreePath, encoding: 'utf8', env: trustedGitEnvironment() });
  const base = run(['rev-parse', '--verify', `${baseRef}^{commit}`]);
  const head = run(['rev-parse', '--verify', 'HEAD^{commit}']);
  if (base.status !== 0 || head.status !== 0) {
    return {
      has_change: false,
      detail: String(base.stderr || head.stderr || 'could not resolve the review change boundary').trim(),
    };
  }
  const baseOid = String(base.stdout || '').trim();
  const headOid = String(head.stdout || '').trim();
  const committed = run(['diff', '--quiet', baseOid, headOid, '--']);
  if (committed.status !== 0 && committed.status !== 1) {
    return {
      has_change: false,
      base: baseOid,
      head: headOid,
      detail: String(committed.stderr || 'could not inspect committed changes').trim(),
    };
  }
  const status = run(['status', '--porcelain=v1', '--untracked-files=all']);
  if (status.status !== 0) {
    return {
      has_change: false,
      base: baseOid,
      head: headOid,
      detail: String(status.stderr || 'could not inspect worktree changes').trim(),
    };
  }
  // Conductor plumbing is not engine output. Counting it as a change is what let a
  // flight report "landed" for an engine that said "nothing to commit": the fleet's
  // own prompt file registered as dirt, has_change went true, and the no_change
  // pause never fired.
  const dirty = String(status.stdout || '').trim().split('\n').filter(Boolean)
    .filter((line) => !isConductorStatusLine(line));
  const hasCommittedDiff = committed.status === 1;
  return {
    has_change: hasCommittedDiff || dirty.length > 0,
    base: baseOid,
    head: headOid,
    commit: hasCommittedDiff ? headOid : null,
    dirty: dirty.length > 0,
    changed_entries: dirty.slice(0, 100),
  };
}

function reviewWorktreeSnapshot(worktreePath) {
  const run = (args) => spawnSync('git', args, { cwd: worktreePath, encoding: 'utf8', env: trustedGitEnvironment() });
  const head = run(['rev-parse', '--verify', 'HEAD^{commit}']);
  const status = run(['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const diff = run(['diff', '--binary', 'HEAD', '--']);
  const untracked = run(['ls-files', '--others', '--exclude-standard', '-z']);
  const localConfig = run(['config', '--local', '--null', '--list', '--show-origin']);
  const worktreeConfig = run(['config', '--worktree', '--null', '--list', '--show-origin']);
  const refs = run(['show-ref', '--head']);
  const failed = [head, status, diff, untracked, localConfig, worktreeConfig, refs]
    .find((result) => result.status !== 0);
  if (failed) {
    return {
      ok: false,
      detail: String(failed.stderr || failed.stdout || 'could not snapshot validator worktree').trim(),
    };
  }
  const hash = crypto.createHash('sha256');
  hash.update(String(head.stdout || ''));
  hash.update('\0status\0');
  hash.update(String(status.stdout || ''));
  hash.update('\0diff\0');
  hash.update(String(diff.stdout || ''));
  hash.update('\0local-config\0');
  hash.update(String(localConfig.stdout || ''));
  hash.update('\0worktree-config\0');
  hash.update(String(worktreeConfig.stdout || ''));
  hash.update('\0refs\0');
  hash.update(String(refs.stdout || ''));
  for (const relative of String(untracked.stdout || '').split('\0').filter(Boolean).sort()) {
    hash.update('\0untracked\0');
    hash.update(relative);
    const absolute = path.resolve(worktreePath, relative);
    try {
      const info = fs.lstatSync(absolute);
      if (info.isSymbolicLink()) hash.update(`symlink:${fs.readlinkSync(absolute)}`);
      else if (info.isFile()) hash.update(fs.readFileSync(absolute));
      else hash.update(`mode:${info.mode}:size:${info.size}`);
    } catch (error) {
      return { ok: false, detail: `could not hash validator worktree entry ${relative}: ${error.message}` };
    }
  }
  return {
    ok: true,
    head: String(head.stdout || '').trim(),
    status: String(status.stdout || ''),
    digest: hash.digest('hex'),
  };
}

async function runIndependentValidator({
  root,
  task,
  worktreePath,
  executorEngine,
  verifierCommand,
  validatorEngines,
  validatorDispatcher = null,
  stateInspector = reviewWorktreeSnapshot,
}) {
  const candidates = [...new Set((validatorEngines || []).map((value) => String(value || '').trim()).filter(Boolean))]
    .filter((name) => RUNNER_PROFILE_DEFS[name] && name !== executorEngine);
  if (!candidates.length) {
    return {
      ok: false,
      stage: 'validator_unavailable',
      validator_result: {
        engine: null,
        executor_engine: executorEngine,
        independent: false,
        passed: false,
        verdict: 'unavailable',
        reason: 'no distinct ready validator is available',
        exit_code: null,
        output: '',
        brief_id: null,
        worktree_unchanged: null,
      },
    };
  }
  const dispatch = validatorDispatcher || ((entry) => Promise.resolve(dispatchToEngine({
    task,
    engine: entry.engine,
    worktreePath,
    root,
    prompt: entry.prompt,
    environment: reviewOnlyEngineEnvironment(worktreePath, {
      engine: entry.engine,
      network: true,
      writable: false,
    }),
    sealed: true,
    allowedTools: VALIDATOR_ALLOWED_TOOLS,
    skipBriefCapture: true,
  })));

  for (let index = 0; index < candidates.length; index += 1) {
    const validatorEngine = candidates[index];
    const prompt = buildOneLapValidatorPrompt(task, { verifierCommand, executorEngine });
    const before = stateInspector(worktreePath);
    if (!before || before.ok !== true) {
      return {
        ok: false,
        stage: 'validator_snapshot_failed',
        validator_result: {
          engine: validatorEngine,
          executor_engine: executorEngine,
          independent: true,
          passed: false,
          verdict: 'invalid',
          reason: String(before && before.detail || 'could not snapshot worktree before validation'),
          exit_code: null,
          output: '',
          brief_id: null,
          worktree_unchanged: null,
        },
      };
    }
    let dispatched;
    try {
      dispatched = normalizeDispatchResult(await dispatch({
        task,
        engine: validatorEngine,
        worktreePath,
        prompt,
      }), validatorEngine);
    } catch (error) {
      dispatched = normalizeDispatchResult({ exitCode: 1, stderr: error.message || String(error) }, validatorEngine);
    }
    const after = stateInspector(worktreePath);
    const output = dispatchResultOutput(dispatched).slice(-8000);
    const verdictOutput = [dispatched.report, dispatched.stdout]
      .map((value) => String(value || ''))
      .filter(Boolean)
      .join('\n');
    const verdict = parseOneLapValidatorVerdict(verdictOutput);
    const unchanged = Boolean(after && after.ok === true && before.digest === after.digest);
    const exitCode = dispatchResultExitCode(dispatched);
    const validatorResult = {
      engine: validatorEngine,
      executor_engine: executorEngine,
      independent: validatorEngine !== executorEngine,
      passed: exitCode === 0 && verdict.passed === true && unchanged,
      verdict: verdict.verdict,
      reason: unchanged ? verdict.reason : String(after && after.detail || 'validator changed the worktree'),
      exit_code: exitCode,
      output,
      brief_id: dispatched.brief_id || null,
      worktree_unchanged: unchanged,
    };
    if (!unchanged) return { ok: false, stage: 'validator_mutated_worktree', validator_result: validatorResult };
    if (exitCode !== 0) {
      const outage = detectDeadEngineDispatch(dispatched);
      if (outage && outage.reason === 'usage_limit' && index + 1 < candidates.length) continue;
      validatorResult.reason = headTail(String(dispatched.stderr || verdict.reason || `validator exited ${exitCode}`).trim());
      return { ok: false, stage: 'validator_failed', validator_result: validatorResult };
    }
    if (verdict.verdict === 'reject') return { ok: false, stage: 'validation_rejected', validator_result: validatorResult };
    if (!verdict.passed) return { ok: false, stage: 'validator_failed', validator_result: validatorResult };
    return { ok: true, stage: 'validator_signed_off', validator_result: validatorResult };
  }
  return { ok: false, stage: 'validator_failed', validator_result: null };
}

function dispatchReceiptResult(flight, { ids, reviewOnly, enforceRemoteBoundary }) {
  const validatorResult = flight.validator_result || flight.result?.validator_result;
  const successfulRows = reviewOnly ? flight.ready : flight.landed;
  const successfulVerifierRows = successfulRows
    .map((row) => row.verifier_result)
    .filter((row) => row && typeof row === 'object');
  const verifierRows = [
    ...successfulVerifierRows,
    ...flight.paused.map((row) => row.verifier_result).filter((row) => row && typeof row === 'object'),
  ];
  const basePassed = flight.paused.length === 0
    && successfulRows.length === ids.length
    && successfulVerifierRows.length === ids.length
    && successfulVerifierRows.every((row) => row.passed === true);
  const oneLapReview = reviewOnly && flight.context && flight.context.source === 'one_lap';
  const validatorPassed = validatorResult
    && validatorResult.passed === true
    && validatorResult.independent === true
    && validatorResult.worktree_unchanged === true
    && validatorResult.engine
    && validatorResult.executor_engine
    && validatorResult.engine !== validatorResult.executor_engine;
  const passed = basePassed && (!oneLapReview || validatorPassed === true);
  const result = {
    kind: reviewOnly ? 'dispatch_review_ready' : 'dispatch_landed',
    passed,
    verifier_result: verifierRows.length === 1
      ? verifierRows[0]
      : { passed, checks: verifierRows },
  };
  if (reviewOnly) {
    result.master_boundary_enforced = enforceRemoteBoundary;
    result.master_unchanged = enforceRemoteBoundary
      ? flight.ready.length === ids.length && flight.ready.every((row) => row.master_before && row.master_before === row.master_after)
      : null;
  }
  if (validatorResult && typeof validatorResult === 'object') {
    result.validator_result = validatorResult;
  }
  return result;
}

function atomicWriteFlightReceipt(flight, receiptPath) {
  flight.receipt = receiptPath;
  fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
  const tempPath = `${receiptPath}.tmp-${process.pid}`;
  fs.writeFileSync(tempPath, `${JSON.stringify(flight, null, 2)}\n`);
  fs.renameSync(tempPath, receiptPath);
}

function startLiveFlight(root, receiptPath, flight) {
  const liveLogPath = createEngineLiveLog(receiptPath);
  flight.status = 'running';
  flight.pid = process.pid;
  flight.started_at = flight.started_at || flight.at || new Date().toISOString();
  flight.live_log = path.relative(root, liveLogPath) || liveLogPath;
  atomicWriteFlightReceipt(flight, receiptPath);
  return liveLogPath;
}

function writeDispatchReceipt(flight, receiptPath, resultOptions) {
  flight.result = dispatchReceiptResult(flight, resultOptions);
  atomicWriteFlightReceipt(flight, receiptPath);
}

function stampDispatchResultVerification(flight, taskId, engine, startedAtMs, verifierResult) {
  if (!verifierResult || typeof verifierResult.passed !== 'boolean') return;
  const row = flight.results.find((result) => result.task === taskId);
  if (!row) return;
  const completedAtMs = Date.now();
  row.engine = engine;
  row.verified_passed = verifierResult.passed;
  row.duration_ms = Math.max(0, completedAtMs - startedAtMs);
  row.at = new Date(completedAtMs).toISOString();
}

function readProjectionTasks(root) {
  try {
    const raw = fs.readFileSync(path.join(root, '.atris', 'state', 'tasks.projection.json'), 'utf8');
    const projection = JSON.parse(raw);
    return Array.isArray(projection.tasks) ? projection.tasks : [];
  } catch {
    return [];
  }
}

function defaultOwnCli(root) {
  const bin = path.resolve(__dirname, '..', 'bin', 'atris.js');
  return (cliArgs, cwd = root) => {
    const result = spawnSync(process.execPath, [bin, ...cliArgs], { cwd, encoding: 'utf8', timeout: 600000 });
    return { status: result.status, stdout: String(result.stdout || ''), stderr: String(result.stderr || '') };
  };
}

// Extract a runnable focused check from the task's Check: line; the wide
// gates (npm test, CI) stay at the ship gate, not per-arrival.
function focusedCheck(task) {
  const { check } = parseDoneCheck(task.title);
  const m = check.match(/node --test \S+/);
  if (!m) return '';
  let cmd = m[0].trim();
  // Board convention often ends the Check: sentence with a trailing period
  // right after the test file path (e.g. "node --test test/x.test.js."). A
  // naive [^.]+ stop would also truncate the ".test.js" extension itself, so
  // only strip the LAST period, and only when the path still ends in a real
  // extension without it (otherwise the period is part of the path).
  if (cmd.endsWith('.')) {
    const stripped = cmd.slice(0, -1);
    if (/\.(js|mjs|cjs|ts|tsx)$/.test(stripped)) cmd = stripped;
  }
  return cmd;
}

// One-command dispatch runs a single explicit task, so the wide-gate caution
// behind focusedCheck (many staffed tasks, keep per-arrival checks narrow)
// does not apply: fall back to the task's whole Check: text so the operator's
// actual check command is what gets re-run as verification.
function dispatchCheck(task) {
  const narrow = focusedCheck(task);
  if (narrow) return narrow;
  const { check } = parseDoneCheck(task.title);
  return check;
}

function readTaskById(cli, taskId) {
  const result = cli(['task', 'show', String(taskId), '--json']);
  if (!result || result.status !== 0) return null;
  try {
    const parsed = JSON.parse(result.stdout);
    return parsed && parsed.display_id ? parsed : null;
  } catch {
    return null;
  }
}

function defaultVerifyRunner(command, cwd) {
  const result = spawnSync(command, { cwd, encoding: 'utf8', shell: true });
  return { status: result.status, stdout: String(result.stdout || ''), stderr: String(result.stderr || '') };
}

function defaultTrustedVerifyRunner(command, cwd) {
  const parsed = require('./auto-accept-certified').parseVerifyCommand(command);
  if (!parsed.ok) return { status: 2, stdout: '', stderr: parsed.reason };
  const worktreeRoot = path.resolve(cwd);
  const insideWorktree = (target) => target === worktreeRoot || target.startsWith(`${worktreeRoot}${path.sep}`);
  const commandCwd = parsed.cwd ? path.resolve(worktreeRoot, parsed.cwd) : worktreeRoot;
  if (!insideWorktree(commandCwd)) {
    return { status: 2, stdout: '', stderr: 'verify_workdir_outside_worktree' };
  }
  if (parsed.argv[0] === 'git' && parsed.argv[1] === '-C') {
    const gitCwd = path.resolve(commandCwd, parsed.argv[2]);
    if (!insideWorktree(gitCwd)) {
      return { status: 2, stdout: '', stderr: 'verify_git_path_outside_worktree' };
    }
  }
  let boundaryEnv;
  try {
    boundaryEnv = reviewOnlyEngineEnvironment(worktreeRoot);
  } catch (error) {
    return { status: 2, stdout: '', stderr: error.message || String(error) };
  }
  const sandboxProfile = String(boundaryEnv.ATRIS_ONE_LAP_SANDBOX_PROFILE || '');
  const runtimeDir = String(boundaryEnv.ATRIS_ONE_LAP_RUNTIME_DIR || '');
  const controlDir = String(boundaryEnv.ATRIS_ONE_LAP_CONTROL_DIR || '');
  const lifecycleWrapper = String(boundaryEnv.ATRIS_ONE_LAP_LIFECYCLE_WRAPPER || '');
  const statusFile = String(boundaryEnv.ATRIS_ONE_LAP_STATUS_FILE || '');
  delete boundaryEnv.ATRIS_ONE_LAP_SANDBOX_PROFILE;
  delete boundaryEnv.ATRIS_ONE_LAP_RUNTIME_DIR;
  delete boundaryEnv.ATRIS_ONE_LAP_CONTROL_DIR;
  delete boundaryEnv.ATRIS_ONE_LAP_LIFECYCLE_WRAPPER;
  delete boundaryEnv.ATRIS_ONE_LAP_STATUS_FILE;
  const executable = sandboxProfile ? '/usr/bin/sandbox-exec' : parsed.argv[0];
  const args = sandboxProfile
    ? ['-p', sandboxProfile, lifecycleWrapper, parsed.argv[0], ...parsed.argv.slice(1)]
    : parsed.argv.slice(1);
  let result;
  try {
    const spawnOptions = {
      cwd: commandCwd,
      env: { ...(parsed.env || {}), ...boundaryEnv },
      encoding: 'utf8',
      shell: false,
      timeout: 120000,
    };
    result = sandboxProfile
      ? runInReapedProcessGroup(executable, args, spawnOptions, controlDir, statusFile)
      : spawnSync(executable, args, spawnOptions);
  } finally {
    if (runtimeDir) fs.rmSync(runtimeDir, { recursive: true, force: true });
    if (controlDir) fs.rmSync(controlDir, { recursive: true, force: true });
  }
  return {
    status: Number.isInteger(result.status) ? result.status : 1,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || result.error && result.error.message || ''),
  };
}

function defaultDispatchStartCommit({ worktreePath, git = null } = {}) {
  const run = git || ((args) => spawnSync('git', args, { cwd: worktreePath, encoding: 'utf8' }));
  const head = run(['rev-parse', '--verify', 'HEAD^{commit}']);
  if (!head || head.status !== 0) return '';
  return String(head.stdout || '').trim();
}

function defaultSelfLandCheck({ worktreePath, targetRef = DISPATCH_SELF_LAND_TARGET, startCommit = '', entry = null, git = null } = {}) {
  const run = git || ((args) => spawnSync('git', args, { cwd: worktreePath, encoding: 'utf8' }));
  const recordedStart = String(startCommit || (entry && entry.startCommit) || '').trim();
  if (!recordedStart) {
    return { ok: false, stage: 'self_land_check', reason: 'unknown_start_commit', target: targetRef, detail: 'dispatch start commit was not recorded' };
  }
  const headResult = run(['rev-parse', '--verify', 'HEAD^{commit}']);
  if (!headResult || headResult.status !== 0) {
    return {
      ok: false,
      stage: 'self_land_check',
      reason: 'unknown_head',
      target: targetRef,
      start_commit: recordedStart,
      detail: String(headResult && (headResult.stderr || headResult.stdout) || '').trim(),
    };
  }
  const head = String(headResult.stdout || '').trim();
  if (head === recordedStart) {
    return {
      ok: false,
      stage: 'no_work_landed',
      reason: 'no_work_landed',
      target: targetRef,
      start_commit: recordedStart,
      head,
      detail: 'no work landed because HEAD still matches the dispatch start commit',
    };
  }
  const diff = run(['diff', '--quiet', recordedStart, head, '--']);
  if (diff.status === 0) {
    return {
      ok: false,
      stage: 'no_work_landed',
      reason: 'no_work_landed',
      target: targetRef,
      start_commit: recordedStart,
      head,
      detail: 'no work landed because the commit changed without changing the tree',
    };
  }
  if (diff.status !== 1) {
    return {
      ok: false,
      stage: 'self_land_check',
      reason: 'diff_check_failed',
      target: targetRef,
      start_commit: recordedStart,
      head,
      detail: String(diff.stderr || diff.stdout || '').trim(),
    };
  }
  const branch = String(targetRef || '').startsWith('origin/') ? String(targetRef).slice('origin/'.length) : '';
  const fetch = run(branch ? ['fetch', 'origin', `${branch}:refs/remotes/origin/${branch}`] : ['fetch', 'origin']);
  if (fetch.status !== 0) {
    return { ok: false, stage: 'self_land_check', target: targetRef, start_commit: recordedStart, head, detail: String(fetch.stderr || fetch.stdout || '').trim() };
  }
  const ancestor = run(['merge-base', '--is-ancestor', 'HEAD', targetRef]);
  if (ancestor.status === 0) return { ok: true, stage: 'self_landed', target: targetRef, start_commit: recordedStart, head };
  if (ancestor.status === 1) {
    return { ok: false, stage: 'self_land_missing', target: targetRef, start_commit: recordedStart, head, detail: `HEAD is not an ancestor of ${targetRef}` };
  }
  return { ok: false, stage: 'self_land_check', target: targetRef, start_commit: recordedStart, head, detail: String(ancestor.stderr || ancestor.stdout || '').trim() };
}

// One flight. Staff -> dispatch in parallel -> land serially -> receipt.
// No fleet state file: progress is narrated via `log`, durability lives in
// worktrees, task claims, and the receipt written at the end.
async function runFleetFlight({
  root = process.cwd(),
  slots = 3,
  engines = null,
  dryRun = false,
  log = console.log,
  ownCli = null,
  dispatcher = null,
  lander = null,
  rebase = null,
  checkoutBase = 'origin/master',
  guardCliLink = guardGlobalCliLink,
  scoutAsk = null,
} = {}) {
  const cli = ownCli || defaultOwnCli(root);
  // Staff first, rank second: every task staffFlight returns already cleared
  // the safe-lane filter (not a decision row, no denied tags), so the rank
  // that pairs engines to those tasks is low stakes and the stretch zone
  // rule may trade the strongest engine for the cheapest learnable one.
  // Protected or denied work never reaches staffFlight's output, so it never
  // gets the flag; when nothing is staffed there is no task to rank for and
  // the flag stays off.
  const staffedTasks = staffFlight(readProjectionTasks(root), { slots });
  const rosterDetail = engines ? null : (() => {
    const { roster: fullRoster } = require('../commands/engine');
    const installed = fullRoster(root)
      .filter((e) => e.installed && FLEET_CAPABLE.includes(e.name))
      .map((e) => e.name);
    return rankFleetEnginesDetailed(installed, root, { lowStakes: staffedTasks.length > 0 });
  })();
  const roster = engines || rosterDetail.candidates;

  const staffed = assignEngines(staffedTasks, roster);
  // The receipt path is decided BEFORE landings so each task's ready-proof
  // can cite it — the proof policy certifies receipt-backed proofs agent-side.
  const receiptPath = path.join(root, 'atris', 'runs', `fleet-${nowStamp()}.json`);
  const flight = {
    at: new Date().toISOString(),
    root,
    slots,
    roster,
    staffed: staffed.map((s) => ({ task: s.task.display_id, title: String(s.task.title || '').slice(0, 140), engine: s.engine, surface: s.surface })),
    stretch_zone_pick: rosterDetail && rosterDetail.stretch_zone_pick ? rosterDetail.stretch_zone_pick : null,
    results: [],
    landed: [],
    paused: [],
  };
  if (flight.stretch_zone_pick) {
    flight.stretch_zone_note = `low-stakes staffing picked ${flight.stretch_zone_pick} from the stretch zone: the cheapest engine with a learnable track record won this lane.`;
  }

  log('');
  log(`  fleet — ${roster.length} engine${roster.length === 1 ? '' : 's'} ready, ${staffed.length} task${staffed.length === 1 ? '' : 's'} staffed`);
  for (const s of staffed) log(`    ${s.engine.padEnd(8)} → ${s.task.display_id}  ${String(s.task.title || '').slice(0, 80)}`);
  log('');

  if (dryRun || staffed.length === 0) {
    flight.dry_run = true;
    return flight;
  }

  const liveLogPath = startLiveFlight(root, receiptPath, flight);

  // Claim + cut a worktree per assignment, then dispatch all in parallel.
  const dispatch = dispatcher || ((entry) => new Promise((resolve) => {
    resolve(dispatchToEngine({
      task: entry.task,
      engine: entry.engine,
      worktreePath: entry.worktreePath,
      root,
      prompt: entry.prompt,
      briefId: entry.brief_id,
      skipBriefCapture: true,
      liveLogPath,
    }));
  }));
  const restaffState = { used: false };

  // Cut every build worktree from origin/master by default, not the launcher's
  // HEAD. A flight launched from a long-lived feature-branch checkout would
  // otherwise stack all that branch's commits onto the build branch, so
  // rebase-before-ship replays them onto master and pauses at rebase_conflict
  // (three backend pauses on members.py, 2026-07-05). --base overrides only
  // when the operator explicitly wants launcher-HEAD.
  const startBaseArgs = checkoutBase ? ['--base', checkoutBase] : [];
  const prepared = [];
  for (const entry of staffed) {
    const claimed = cli(['task', 'claim', String(entry.task.display_id), '--as', `fleet-${entry.engine}`]);
    if (!claimed || claimed.status !== 0) {
      const detail = String(claimed && (claimed.stderr || claimed.stdout) || 'claim failed').trim().slice(0, 300);
      flight.paused.push({ task: entry.task.display_id, engine: entry.engine, stage: 'claim', detail });
      log(`    ${entry.engine.padEnd(8)} ⏸ paused ${entry.task.display_id} at claim${detail ? ` — ${detail}` : ''}`);
      continue;
    }
    const started = cli(['worktree', 'start', '--agent', entry.engine, '--task', `fleet-${String(entry.task.display_id).toLowerCase()}`, ...startBaseArgs]);
    const wt = (started.stdout.match(/next: cd (.+)/) || [])[1];
    if (!wt) {
      flight.paused.push({ task: entry.task.display_id, stage: 'worktree_start', detail: started.stderr.slice(0, 200) });
      continue;
    }
    prepared.push({ ...entry, worktreePath: wt.trim() });
    log(`    ${entry.engine.padEnd(8)} building ${entry.task.display_id} in ${path.basename(wt.trim())}`);
  }

  const results = await Promise.all(prepared.map((entry) =>
    dispatchEntryWithRestaff({
      entry,
      engine: entry.engine,
      root,
      dispatch,
      installedEngines: roster,
      restaffState,
      scoutAsk: scoutAsk === null && dispatcher ? false : (scoutAsk || undefined),
    }).then((result) => ({ entry, result }))
  ));
  flight.results = results.map(({ entry, result }) => {
    const row = { task: entry.task.display_id, engine: result.engine || entry.engine, exitCode: result.exitCode };
    if (result.brief_id) row.brief_id = result.brief_id;
    if (result.restaffed) row.restaffed = result.restaffed;
    if (result.deadEngine) row.deadEngine = result.deadEngine;
    return row;
  });

  // Land serially: rebase-before-ship, conflict pauses (never auto-resolve).
  const rebaseArrival = rebase || landArrival;
  const land = lander || (({ entry }) => {
    const rebased = rebaseArrival({ worktreePath: entry.worktreePath });
    if (!rebased.ok) return rebased;
    const check = focusedCheck(entry.task) || 'git log -1 --oneline';
    const shipped = shipWithRetry(cli, fleetShipArgs(entry, check), entry.worktreePath);
    if (shipped.status !== 0 || !/done: worktree shipped/.test(shipped.stdout)) {
      return { ok: false, stage: 'ship', detail: shipFailureDetail(shipped) };
    }
    return { ok: true, stage: 'shipped' };
  });

  for (const { entry, result } of results) {
    const activeEngine = result.engine || entry.engine;
    const landingEntry = { ...entry, engine: activeEngine };
    if (result.restaffed) log(`    restaffed ${entry.task.display_id}: ${result.restaffed.from} -> ${result.restaffed.to} (${result.restaffed.reason})`);
    const buildFailure = detectDeadEngineDispatch(result);
    if (buildFailure) {
      const paused = {
        task: entry.task.display_id,
        engine: activeEngine,
        stage: 'build',
        reason: buildFailure.reason,
        detail: String(result.stderr || buildFailure.reason).slice(0, 200),
      };
      if (result.restaffed) paused.restaffed = result.restaffed;
      if (result.deadEngine) paused.deadEngine = result.deadEngine;
      flight.paused.push(paused);
      stampDispatchBrief(root, result.brief_id, 'fail', `build failed for ${entry.task.display_id}`);
      log(`    ${activeEngine.padEnd(8)} ✗ build failed ${entry.task.display_id} — worktree kept for takeover`);
      continue;
    }
    log(`    ${activeEngine.padEnd(8)} landing ${entry.task.display_id}...`);
    const landed = land({ entry: landingEntry, result });
    if (landed.ok) {
      const landedRow = { task: entry.task.display_id, engine: activeEngine };
      if (result.brief_id) landedRow.brief_id = result.brief_id;
      if (result.restaffed) landedRow.restaffed = result.restaffed;
      flight.landed.push(landedRow);
      stampDispatchBrief(root, result.brief_id, 'pass', `landed ${entry.task.display_id} via fleet ship`);
      const restaffProof = result.restaffed ? ` Restaffed from ${result.restaffed.from} to ${result.restaffed.to} (${result.restaffed.reason}).` : '';
      cli([
        'task', 'ready', String(entry.task.display_id),
        '--proof', `Built by ${activeEngine} engine in fleet flight.${restaffProof} Landed via worktree ship gate (rebase-before-ship, verify re-run). Receipt saved at ${path.relative(root, receiptPath)}. Report tail: ${headTail(String(result.report || '').replace(/\n/g, ' '))}`,
        '--result', 'Operators can now review fleet-shipped work faster because the worktree was verified before landing.',
        '--as', `fleet-${activeEngine}`,
      ]);
      log(`    ${activeEngine.padEnd(8)} ✓ landed ${entry.task.display_id}`);
    } else {
      flight.paused.push({ task: entry.task.display_id, engine: activeEngine, ...(result.restaffed ? { restaffed: result.restaffed } : {}), ...landed });
      stampDispatchBrief(root, result.brief_id, 'partial', `paused ${entry.task.display_id} at ${landed.stage || 'landing'}`);
      log(`    ${activeEngine.padEnd(8)} ⏸ paused ${entry.task.display_id} at ${landed.stage}${pausedPathsSuffix(landed)} — worktree kept`);
    }
  }

  // Teardown guard: a build worktree may have run `npm link` and hijacked the
  // global `atris`. Before reporting success, make sure this flight did not
  // leave the global CLI pointed into one of its own worktrees.
  const flightWorktrees = prepared.map((entry) => entry.worktreePath).filter(Boolean);
  const cliLink = guardCliLink({ root, worktreePaths: flightWorktrees });
  flight.cli_link = cliLink;
  if (cliLink.changed) {
    log(cliLink.ok
      ? `  restored global atris link (was ${cliLink.reason}); repointed at ${path.relative(root, cliLink.restoredTo) || cliLink.restoredTo} and the cli runs`
      : `  alert: global atris link was ${cliLink.reason}; repoint attempted at ${cliLink.restoredTo} but the cli still fails, so every cron/loop/mission is down`);
  }

  releasePausedClaimsWithoutWork(cli, {
    paused: flight.paused,
    worktreeByTask: new Map(prepared.map((entry) => [String(entry.task.display_id), entry.worktreePath])),
    actorByTask: new Map(staffed.map((entry) => [String(entry.task.display_id), `fleet-${entry.engine}`])),
    baseRef: checkoutBase || 'origin/master',
    log,
  });

  flight.status = flight.paused.length ? 'failed' : 'completed';
  flight.finished_at = new Date().toISOString();
  atomicWriteFlightReceipt(flight, receiptPath);
  log('');
  log(`  flight over: ${flight.landed.length} landed, ${flight.paused.length} paused · receipt: ${path.relative(root, flight.receipt)}`);
  log('');
  return flight;
}

// ---------------------------------------------------------------------------
// T5 — one-command dispatch: `atris engine dispatch <task-id> --engine <name>`

// A claim taken before the engine starts must not stay held if the flight
// refuses or errors first. Release through the same task plane the claim used.
function releaseUnstartedDispatchClaim(cli, { taskId, actor, detail }) {
  const released = cli(['task', 'release', taskId, '--as', actor]);
  const releasedOk = Boolean(released && released.status === 0);
  const suffix = releasedOk
    ? 'claim released, safe to retry'
    : `claim release failed: ${String(released && (released.stderr || released.stdout) || 'unknown').trim().slice(0, 80)}`;
  const base = String(detail || '').trim().slice(0, 200);
  return { released: releasedOk, detail: base ? `${base}. ${suffix}` : suffix };
}

// A pause with no work must not keep the task. On 2026-08-21, 49 bug tasks sat
// falsely "in progress" because guard-blocked engines paused their flights
// while the claims taken before dispatch outlived them. After landing, any
// paused task whose worktree holds no commits past base and nothing but
// conductor litter gets its claim released; a paused task WITH work keeps the
// claim so takeover stays attributed.
function releasePausedClaimsWithoutWork(cli, { paused, worktreeByTask, actorByTask, baseRef = 'origin/master', log = () => {} }) {
  for (const row of paused || []) {
    if (row.stage === 'claim' || row.stage === 'task_lookup') continue; // claim never held
    if (row.claim_released !== undefined) continue;
    const taskId = String(row.task || '');
    const actor = actorByTask.get(taskId);
    if (!taskId || !actor) continue;
    const worktreePath = row.worktree || worktreeByTask.get(taskId) || '';
    if (worktreePath && fs.existsSync(worktreePath)) {
      const ahead = spawnSync('git', ['-C', worktreePath, 'rev-list', '--count', `${baseRef}..HEAD`], { encoding: 'utf8' });
      if (ahead.status !== 0 || parseInt(String(ahead.stdout).trim(), 10) > 0) continue;
      // -uall lists untracked files one by one; the default collapses a fully
      // untracked .atris/ into "?? .atris/", which the allowlist cannot judge.
      const status = spawnSync('git', ['-C', worktreePath, 'status', '--porcelain', '-uall'], { encoding: 'utf8' });
      if (status.status !== 0) continue;
      const dirt = String(status.stdout || '').split('\n').filter(Boolean).filter((line) => !isConductorStatusLine(line));
      if (dirt.length > 0) continue;
    } else if (row.stage !== 'worktree_start' && row.stage !== 'remote_quarantine' && row.stage !== 'prepare') {
      continue; // worktree gone and stage ambiguous: leave the claim for a human
    }
    const released = cli(['task', 'release', taskId, '--as', actor]);
    row.claim_released = Boolean(released && released.status === 0);
    if (row.claim_released) log(`    released claim on ${taskId} (engine produced no work)`);
  }
}

// The manual version of this loop took 6 Bash calls per task the night this
// was written: claim, worktree start, prompt file, engine -p, verify, ship.
// One or more explicit task ids build in parallel isolated worktrees on ONE
// named engine; landings are serial, reusing the same rebase-before-ship,
// never-auto-resolve contract as the fleet. Unlike the fleet, dispatch
// re-runs the task's own Check: command directly (not just via the ship
// gate) and captures its real output for the ready proof, so proof text cites
// an actual re-runnable verifier instead of an engine's self-report.
async function runDispatchFlight({
  root = process.cwd(),
  taskIds = [],
  engine,
  prompt: promptOverride = '',
  log = console.log,
  ownCli = null,
  dispatcher = null,
  lander = null,
  verifier = null,
  rebase = null,
  checkoutBase = null,
  installedEngines = null,
  selfLandCheck = null,
  startCommitReader = null,
  yolo = false,
  reviewOnly = false,
  verifierCommand = '',
  receiptContext = null,
  actor = '',
  changeInspector = null,
  validatorEngines = null,
  validatorDispatcher = null,
  validatorStateInspector = null,
  scoutAsk = null,
} = {}) {
  if (!engine) throw new Error('runDispatchFlight: engine is required');
  if (!DISPATCH_CAPABLE.includes(engine)) {
    throw new Error(`runDispatchFlight: engine "${engine}" cannot build headlessly (capable: ${DISPATCH_CAPABLE.join(', ')})`);
  }
  const ids = [...new Set((taskIds || []).map((id) => String(id).trim()).filter(Boolean))];
  if (!ids.length) throw new Error('runDispatchFlight: at least one task id is required');
  if (promptOverride && ids.length > 1) {
    throw new Error('runDispatchFlight: --prompt-file only supports a single task id');
  }
  const trustedVerifier = String(verifierCommand || '').trim();
  if (trustedVerifier) {
    const parsedVerifier = require('./auto-accept-certified').parseVerifyCommand(trustedVerifier);
    if (!parsedVerifier.ok) {
      throw new Error(`runDispatchFlight: verifier command is not allowed (${parsedVerifier.reason})`);
    }
  }
  if (reviewOnly && !trustedVerifier) {
    throw new Error('runDispatchFlight: review-only dispatch requires an explicit verifier command');
  }

  const cli = ownCli || defaultOwnCli(root);
  // Cut worktrees from — and check self-landing against — the workspace's real
  // protected branch, not a hard-coded origin/master (CLI-1298).
  const landTarget = resolveDispatchLandTarget(root, checkoutBase);
  const verify = verifier || (trustedVerifier ? defaultTrustedVerifyRunner : defaultVerifyRunner);
  const inspectChange = changeInspector || inspectReviewChange;
  const readStartCommit = startCommitReader || defaultDispatchStartCommit;
  const enforceRemoteBoundary = reviewOnly && !dispatcher;
  const explicitActor = String(actor || '').trim();
  const taskActor = explicitActor || `fleet-${engine}`;
  const receiptPath = path.join(root, 'atris', 'runs', `dispatch-${nowStamp()}.json`);
  const flight = {
    schema: 'atris.dispatch_receipt.v1',
    at: new Date().toISOString(),
    root,
    engine,
    tasks: ids,
    results: [],
    landed: [],
    ready: [],
    paused: [],
  };
  if (yolo) flight.yolo = true;
  if (reviewOnly) flight.review_only = true;
  flight.actor = taskActor;
  if (receiptContext && typeof receiptContext === 'object') flight.context = receiptContext;
  const requiresIndependentValidator = reviewOnly && flight.context && flight.context.source === 'one_lap';
  const liveLogPath = startLiveFlight(root, receiptPath, flight);

  log('');
  log(`  dispatch — ${ids.length} task${ids.length === 1 ? '' : 's'} -> ${engine}`);
  log('');

  // Same rule as the fleet: dispatch worktrees cut from the protected branch by
  // default so rebase-before-ship never replays a launcher feature branch.
  const startBaseArgs = landTarget ? ['--base', landTarget] : [];
  const prepared = [];
  for (const taskId of ids) {
    const task = readTaskById(cli, taskId);
    if (!task) {
      flight.paused.push({ task: taskId, stage: 'task_lookup', detail: 'task not found' });
      log(`    ✗ ${taskId} not found`);
      continue;
    }
    const claimed = cli(['task', 'claim', taskId, '--as', taskActor]);
    if (!claimed || claimed.status !== 0) {
      const detail = String(claimed && (claimed.stderr || claimed.stdout) || 'claim failed').trim().slice(0, 300);
      flight.paused.push({ task: taskId, stage: 'claim', detail });
      log(`    x ${taskId} claim failed`);
      continue;
    }
    try {
      let landingWorktreePath = '';
      let remoteBoundary = null;
      if (enforceRemoteBoundary) {
        remoteBoundary = prepareReviewSandbox({ root, taskId, engine });
      } else {
        const started = cli(['worktree', 'start', '--agent', engine, '--task', `dispatch-${taskId.toLowerCase()}`, ...startBaseArgs]);
        const wt = (started.stdout.match(/next: cd (.+)/) || [])[1];
        if (!wt) {
          const released = releaseUnstartedDispatchClaim(cli, {
            taskId,
            actor: taskActor,
            detail: String(started.stderr || '').slice(0, 200),
          });
          flight.paused.push({ task: taskId, stage: 'worktree_start', detail: released.detail, claim_released: released.released });
          log(`    ✗ ${taskId} worktree start failed`);
          continue;
        }
        landingWorktreePath = wt.trim();
      }
      if (enforceRemoteBoundary && (!remoteBoundary || remoteBoundary.ok !== true)) {
        const released = releaseUnstartedDispatchClaim(cli, {
          taskId,
          actor: taskActor,
          detail: headTail(String(remoteBoundary && remoteBoundary.detail || 'could not prepare a sealed review sandbox')),
        });
        flight.paused.push({
          task: taskId,
          stage: 'remote_quarantine',
          detail: released.detail,
          worktree: null,
          claim_released: released.released,
        });
        log(`    paused ${taskId} because its sealed review sandbox could not be prepared`);
        continue;
      }
      const worktreePath = enforceRemoteBoundary ? remoteBoundary.worktreePath : landingWorktreePath;
      const startCommit = yolo ? readStartCommit({ worktreePath }) : '';
      const basePrompt = promptOverride || buildFleetPrompt(task, { worktreePath, yolo });
      const safetyPrompt = reviewOnly
        ? `${basePrompt}\n\nSafety boundary: edit and test this checkout only. Do not push, merge, deploy, publish, send messages, change cloud state, install dependencies, or use credentials.`
        : basePrompt;
      const trustedPrompt = trustedVerifier
        ? `${safetyPrompt}\n\nTrusted verifier (run it bare before reporting done): ${trustedVerifier}`
        : promptOverride;
      prepared.push({
        task,
        taskId,
        worktreePath,
        landingWorktreePath,
        engine,
        remoteBoundary,
        remoteMasterBefore: remoteBoundary ? remoteBoundary.protectedMaster : '',
        startCommit,
        ...(trustedPrompt ? { prompt: trustedPrompt } : {}),
      });
      log(`    building ${taskId} in ${path.basename(worktreePath)}`);
    } catch (err) {
      const released = releaseUnstartedDispatchClaim(cli, {
        taskId,
        actor: taskActor,
        detail: String(err && err.message || err).slice(0, 200),
      });
      flight.paused.push({ task: taskId, stage: 'prepare', detail: released.detail, claim_released: released.released });
      log(`    ✗ ${taskId} prepare failed`);
    }
  }

  const dispatch = dispatcher || ((entry) => new Promise((resolve) => {
    resolve(dispatchToEngine({
      task: entry.task,
      engine: entry.engine,
      worktreePath: entry.worktreePath,
      root,
      prompt: entry.prompt || promptOverride || undefined,
      environment: enforceRemoteBoundary ? reviewOnlyEngineEnvironment(entry.worktreePath, {
        engine: entry.engine,
        network: true,
        writable: true,
      }) : null,
      sealed: enforceRemoteBoundary,
      yolo,
      briefId: entry.brief_id,
      skipBriefCapture: true,
      liveLogPath,
    }));
  }));
  const restaffState = { used: false };

  if (engine === 'fable' && prepared.length) {
    log(`  fable handoff started: receipt ${path.relative(root, receiptPath)}`);
  }

  const results = await Promise.all(prepared.map((entry) => {
    const startedAtMs = Date.now();
    return dispatchEntryWithRestaff({
      entry,
      engine: entry.engine,
      root,
      dispatch,
      installedEngines,
      restaffState,
      scoutAsk: scoutAsk === null && dispatcher ? false : (scoutAsk || undefined),
    }).then((result) => {
      const completedAtMs = Date.now();
      return {
        entry,
        result,
        startedAtMs,
        completedAtMs,
        candidate: enforceRemoteBoundary && !detectDeadEngineDispatch(result)
          ? reviewCandidateSnapshot(entry.remoteBoundary)
          : null,
      };
    });
  }));
  flight.results = results.map(({ entry, result, candidate, startedAtMs, completedAtMs }) => {
    const row = {
      task: entry.taskId,
      engine: result.engine || entry.engine,
      task_type: 'executor',
      verified_passed: null,
      duration_ms: Math.max(0, completedAtMs - startedAtMs),
      at: new Date(completedAtMs).toISOString(),
      exitCode: result.exitCode,
    };
    if (entry.startCommit) row.start_commit = entry.startCommit;
    if (result.brief_id) row.brief_id = result.brief_id;
    if (result.restaffed) row.restaffed = result.restaffed;
    if (result.deadEngine) row.deadEngine = result.deadEngine;
    if (candidate && candidate.ok) {
      row.candidate_commit = candidate.commit;
      row.candidate_tree = candidate.tree;
    }
    return row;
  });

  // Land serially: rebase, re-run the trusted verifier for real, then either
  // stop proof-ready in Review or ship. Conflict/verify failure always pauses.
  const rebaseArrival = rebase || landArrival;
  const checkSelfLand = selfLandCheck || defaultSelfLandCheck;
  const land = lander || (({ entry }) => {
    const rebased = enforceRemoteBoundary
      ? { ok: true, stage: 'frozen_base' }
      : rebaseArrival({ worktreePath: entry.worktreePath });
    if (!rebased.ok) return rebased;
    if (enforceRemoteBoundary) {
      const candidate = reviewCandidateSnapshot(entry.remoteBoundary, entry.candidate);
      if (!candidate.ok) return candidate;
    }
    const change = reviewOnly ? inspectChange(entry.worktreePath, landTarget) : null;
    if (reviewOnly && (!change || change.has_change !== true)) {
      return {
        ok: false,
        stage: 'no_change',
        detail: headTail(String(change && change.detail || 'the engine produced no committed or worktree diff')),
        change: change || null,
      };
    }
    if (enforceRemoteBoundary && (change.head !== entry.candidate.commit || change.dirty)) {
      return {
        ok: false,
        stage: 'candidate_changed',
        detail: 'the change selected for verification differs from the frozen executor commit',
        change,
      };
    }
    const check = trustedVerifier || dispatchCheck(entry.task) || 'git log -1 --oneline';
    const verified = verify(check, entry.worktreePath);
    const verifierResult = {
      command: check,
      passed: verified.status === 0,
      status: verified.status,
      output: `${verified.stdout || ''}${verified.stderr || ''}`.slice(-4000),
      ...(entry.candidate && entry.candidate.ok ? {
        candidate_commit: entry.candidate.commit,
        candidate_tree: entry.candidate.tree,
      } : {}),
    };
    if (verified.status !== 0) {
      return {
        ok: false,
        stage: 'verify_failed',
        detail: headTail(`${verified.stdout}${verified.stderr}`),
        verifyOutput: `${verified.stdout}${verified.stderr}`,
        check,
        verifier_result: verifierResult,
      };
    }
    if (enforceRemoteBoundary) {
      const candidate = reviewCandidateSnapshot(entry.remoteBoundary, entry.candidate);
      if (!candidate.ok) return { ...candidate, check, verifier_result: verifierResult };
    }
    if (reviewOnly) {
      return {
        ok: true,
        stage: 'verified_for_review',
        check,
        verifyOutput: `${verified.stdout}${verified.stderr}`,
        verifier_result: verifierResult,
        change,
      };
    }
    const shipped = shipWithRetry(cli, fleetShipArgs({ task: entry.task, engine: entry.engine || engine }, check), entry.worktreePath);
    if (shipped.status !== 0 || !/done: worktree shipped/.test(shipped.stdout)) {
      return { ok: false, stage: 'ship', detail: shipFailureDetail(shipped) };
    }
    return {
      ok: true,
      stage: 'shipped',
      check,
      verifyOutput: `${verified.stdout}${verified.stderr}`,
      verifier_result: verifierResult,
    };
  });

  for (const { entry, result, candidate, startedAtMs } of results) {
    const activeEngine = result.engine || entry.engine || engine;
    const readyActor = explicitActor || `fleet-${activeEngine}`;
    const landingEntry = { ...entry, engine: activeEngine, candidate };
    if (result.restaffed) log(`    restaffed ${entry.taskId}: ${result.restaffed.from} -> ${result.restaffed.to} (${result.restaffed.reason})`);
    const buildFailure = detectDeadEngineDispatch(result);
    if (buildFailure) {
      const paused = {
        task: entry.taskId,
        engine: activeEngine,
        stage: 'build',
        reason: buildFailure.reason,
        detail: String(result.stderr || buildFailure.reason).slice(0, 300),
        worktree: entry.worktreePath,
      };
      if (result.restaffed) paused.restaffed = result.restaffed;
      if (result.deadEngine) paused.deadEngine = result.deadEngine;
      flight.paused.push(paused);
      stampDispatchBrief(root, result.brief_id, 'fail', `build failed for ${entry.taskId}`);
      log(`    ✗ build failed ${entry.taskId} — worktree kept for takeover`);
      continue;
    }
    if (enforceRemoteBoundary && (!candidate || candidate.ok !== true)) {
      const paused = {
        task: entry.taskId,
        engine: activeEngine,
        stage: candidate && candidate.stage || 'candidate_changed',
        detail: headTail(String(candidate && candidate.detail || 'the executor candidate could not be frozen')),
        worktree: entry.worktreePath,
      };
      flight.paused.push(paused);
      stampDispatchBrief(root, result.brief_id, 'fail', `blocked ${entry.taskId}: candidate could not be frozen`);
      log(`    paused ${entry.taskId} at ${paused.stage} - worktree kept`);
      continue;
    }
    if (enforceRemoteBoundary) {
      const boundaryAfterBuild = reviewRemoteBoundaryState(entry.worktreePath, entry.remoteBoundary);
      if (!boundaryAfterBuild.ok) {
        flight.paused.push({
          task: entry.taskId,
          engine: activeEngine,
          stage: boundaryAfterBuild.stage,
          detail: boundaryAfterBuild.detail,
          worktree: entry.worktreePath,
          master_before: entry.remoteMasterBefore || null,
          master_after: boundaryAfterBuild.protected_master || null,
        });
        stampDispatchBrief(root, result.brief_id, 'fail', `blocked ${entry.taskId}: ${boundaryAfterBuild.stage} during build`);
        log(`    paused ${entry.taskId} at ${boundaryAfterBuild.stage} - worktree kept`);
        continue;
      }
    }
    if (yolo) {
      log(`    checking self-land ${entry.taskId}...`);
      const selfLanded = checkSelfLand({
        entry,
        result,
        worktreePath: entry.worktreePath,
        targetRef: landTarget,
        startCommit: entry.startCommit,
      });
      if (selfLanded.ok) {
        const target = selfLanded.target || landTarget;
        flight.landed.push({
          task: entry.taskId,
          engine: activeEngine,
          landing: 'self',
          target,
          verifier_result: {
            command: `HEAD and its tree differ from dispatch start commit; git merge-base --is-ancestor HEAD ${target}`,
            passed: true,
            status: 0,
            output: `HEAD ${selfLanded.head || ''} differs from ${selfLanded.start_commit || entry.startCommit} and is an ancestor of ${target}`,
          },
          ...(result.brief_id ? { brief_id: result.brief_id } : {}),
        });
        stampDispatchBrief(root, result.brief_id, 'pass', `self-landed ${entry.taskId}`);
        log(`    ✓ self-landed ${entry.taskId}`);
      } else {
        const stage = selfLanded.stage || 'self_land_missing';
        flight.paused.push({
          task: entry.taskId,
          engine,
          stage,
          target: selfLanded.target || landTarget,
          detail: selfLanded.detail || '',
        });
        stampDispatchBrief(root, result.brief_id, 'partial', stage === 'no_work_landed'
          ? `no work landed for ${entry.taskId}`
          : `self-land check paused ${entry.taskId} at ${stage}`);
        log(stage === 'no_work_landed'
          ? `    ⏸ no work landed for ${entry.taskId}`
          : `    ⏸ paused ${entry.taskId} at ${stage}`);
      }
      continue;
    }
    log(`    ${reviewOnly ? 'checking' : 'landing'} ${entry.taskId}...`);
    const landed = land({ entry: landingEntry, result });
    stampDispatchResultVerification(
      flight,
      entry.taskId,
      activeEngine,
      startedAtMs,
      landed.verifier_result,
    );
    if (landed.ok) {
      const verifyTail = String(landed.verifyOutput || '').trim().slice(-1200).replace(/\n/g, ' ');
      const restaffProof = result.restaffed ? ` Restaffed from ${result.restaffed.from} to ${result.restaffed.to} (${result.restaffed.reason}).` : '';
      if (reviewOnly) {
        let finalMaster = entry.remoteMasterBefore;
        const boundaryBeforeReview = enforceRemoteBoundary
          ? reviewRemoteBoundaryState(entry.worktreePath, entry.remoteBoundary)
          : { ok: true, protected_master: '' };
        if (!boundaryBeforeReview.ok) {
          flight.paused.push({
            task: entry.taskId,
            engine: activeEngine,
            stage: boundaryBeforeReview.stage,
            detail: boundaryBeforeReview.detail,
            worktree: entry.worktreePath,
            master_before: entry.remoteMasterBefore,
            master_after: boundaryBeforeReview.protected_master || null,
          });
          stampDispatchBrief(root, result.brief_id, 'fail', `blocked ${entry.taskId}: ${boundaryBeforeReview.stage} before Review`);
          log(`    paused ${entry.taskId} at ${boundaryBeforeReview.stage} - worktree kept`);
          continue;
        }
        finalMaster = boundaryBeforeReview.protected_master || finalMaster;
        const change = landed.change || inspectChange(entry.worktreePath, landTarget);
        if (!change || change.has_change !== true) {
          flight.paused.push({
            task: entry.taskId,
            engine: activeEngine,
            stage: 'no_change',
            detail: headTail(String(change && change.detail || 'the engine produced no committed or worktree diff')),
            check: landed.check,
            verifier_result: landed.verifier_result,
            worktree: entry.worktreePath,
            change: change || null,
          });
          stampDispatchBrief(root, result.brief_id, 'partial', `verified ${entry.taskId}, but no code change was found`);
          log(`    paused ${entry.taskId} at no_change - worktree kept`);
          continue;
        }
        let validatorResult = null;
        if (requiresIndependentValidator) {
          log(`    validating ${entry.taskId} in a fresh context...`);
          const validation = await runIndependentValidator({
            root,
            task: entry.task,
            worktreePath: entry.worktreePath,
            executorEngine: activeEngine,
            verifierCommand: landed.check,
            validatorEngines,
            validatorDispatcher,
            stateInspector: validatorStateInspector || reviewWorktreeSnapshot,
          });
          validatorResult = validation.validator_result;
          flight.validator_result = validatorResult;
          if (!validation.ok) {
            flight.paused.push({
              task: entry.taskId,
              engine: activeEngine,
              stage: validation.stage,
              detail: headTail(String(validatorResult && validatorResult.reason || 'independent validator failed')),
              check: landed.check,
              verifier_result: landed.verifier_result,
              validator_result: validatorResult,
              worktree: entry.worktreePath,
              change,
            });
            stampDispatchBrief(root, result.brief_id, 'partial', `validator paused ${entry.taskId} at ${validation.stage}`);
            log(`    paused ${entry.taskId} at ${validation.stage} - worktree kept`);
            continue;
          }
          if (enforceRemoteBoundary) {
            const candidateAfterValidator = reviewCandidateSnapshot(entry.remoteBoundary, candidate);
            if (!candidateAfterValidator.ok) {
              validatorResult.passed = false;
              validatorResult.reason = candidateAfterValidator.detail;
              flight.paused.push({
                task: entry.taskId,
                engine: activeEngine,
                stage: candidateAfterValidator.stage,
                detail: candidateAfterValidator.detail,
                check: landed.check,
                verifier_result: landed.verifier_result,
                validator_result: validatorResult,
                worktree: entry.worktreePath,
                change,
              });
              stampDispatchBrief(root, result.brief_id, 'fail', `blocked ${entry.taskId}: candidate changed during validation`);
              log(`    paused ${entry.taskId} at ${candidateAfterValidator.stage} - worktree kept`);
              continue;
            }
          }
          if (enforceRemoteBoundary) {
            const boundaryAfterValidator = reviewRemoteBoundaryState(entry.worktreePath, entry.remoteBoundary);
            if (!boundaryAfterValidator.ok) {
              validatorResult.passed = false;
              validatorResult.reason = boundaryAfterValidator.detail;
              flight.paused.push({
                task: entry.taskId,
                engine: activeEngine,
                stage: boundaryAfterValidator.stage,
                detail: validatorResult.reason,
                check: landed.check,
                verifier_result: landed.verifier_result,
                validator_result: validatorResult,
                worktree: entry.worktreePath,
                master_before: entry.remoteMasterBefore,
                master_after: boundaryAfterValidator.protected_master || null,
                change,
              });
              stampDispatchBrief(root, result.brief_id, 'fail', `blocked ${entry.taskId}: ${boundaryAfterValidator.stage} during validation`);
              log(`    paused ${entry.taskId} at ${boundaryAfterValidator.stage} - worktree kept`);
              continue;
            }
            finalMaster = boundaryAfterValidator.protected_master;
          }
          log(`    validator ${validatorResult.engine} signed off ${entry.taskId}`);
        }
        let reviewWorktreePath = entry.worktreePath;
        let reviewChange = change;
        if (enforceRemoteBoundary) {
          const imported = importReviewCommit(entry.remoteBoundary, {
            cli,
            taskId: entry.taskId,
            engine: activeEngine,
            expectedCommit: candidate.commit,
            expectedTree: candidate.tree,
            startBaseArgs,
          });
          if (!imported.ok) {
            flight.paused.push({
              task: entry.taskId,
              engine: activeEngine,
              stage: imported.stage || 'review_import',
              detail: imported.detail || 'the verified commit could not be imported for Review',
              check: landed.check,
              verifier_result: landed.verifier_result,
              ...(validatorResult ? { validator_result: validatorResult } : {}),
              worktree: imported.worktreePath || entry.worktreePath,
              master_before: entry.remoteMasterBefore,
              master_after: imported.protected_master || finalMaster || null,
              change,
            });
            stampDispatchBrief(root, result.brief_id, 'fail', `blocked ${entry.taskId}: ${imported.stage || 'review_import'}`);
            log(`    paused ${entry.taskId} at ${imported.stage || 'review_import'} - sandbox kept`);
            continue;
          }
          const boundaryAfterImport = reviewRemoteBoundaryState(entry.worktreePath, entry.remoteBoundary);
          if (!boundaryAfterImport.ok) {
            flight.paused.push({
              task: entry.taskId,
              engine: activeEngine,
              stage: boundaryAfterImport.stage,
              detail: boundaryAfterImport.detail,
              check: landed.check,
              verifier_result: landed.verifier_result,
              ...(validatorResult ? { validator_result: validatorResult } : {}),
              worktree: imported.worktreePath,
              master_before: entry.remoteMasterBefore,
              master_after: boundaryAfterImport.protected_master || null,
              change,
            });
            stampDispatchBrief(root, result.brief_id, 'fail', `blocked ${entry.taskId}: ${boundaryAfterImport.stage} after import`);
            log(`    paused ${entry.taskId} at ${boundaryAfterImport.stage} after import`);
            continue;
          }
          reviewWorktreePath = imported.worktreePath;
          reviewChange = imported.change;
          if (!reviewChange || reviewChange.has_change !== true
            || reviewChange.source_commit !== candidate.commit
            || reviewChange.proof_tree !== candidate.tree
            || imported.head !== candidate.commit) {
            flight.paused.push({
              task: entry.taskId,
              engine: activeEngine,
              stage: 'review_import',
              detail: 'the imported review worktree did not preserve the verified change',
              check: landed.check,
              verifier_result: landed.verifier_result,
              ...(validatorResult ? { validator_result: validatorResult } : {}),
              worktree: reviewWorktreePath,
              master_before: entry.remoteMasterBefore,
              master_after: boundaryAfterImport.protected_master || null,
              change: reviewChange || null,
            });
            stampDispatchBrief(root, result.brief_id, 'fail', `blocked ${entry.taskId}: imported review mismatch`);
            log(`    paused ${entry.taskId} at review_import - review worktree kept`);
            continue;
          }
          finalMaster = boundaryAfterImport.protected_master || finalMaster;
          disposeReviewSandbox(entry.remoteBoundary);
        }
        const shipArgs = fleetShipArgs({ task: entry.task, engine: activeEngine }, landed.check);
        const shellQuote = (value) => /^[A-Za-z0-9_./:-]+$/.test(String(value))
          ? String(value)
          : `'${String(value).replace(/'/g, `'"'"'`)}'`;
        const nextCommand = `cd ${shellQuote(reviewWorktreePath)} && atris ${shipArgs.map(shellQuote).join(' ')}`;
        const readyRow = {
          task: entry.taskId,
          engine: activeEngine,
          check: landed.check,
          verifier_result: landed.verifier_result,
          worktree: reviewWorktreePath,
          next_action: nextCommand,
          change: reviewChange,
          ...(validatorResult ? { validator_result: validatorResult } : {}),
          review_recorded: false,
          ...(enforceRemoteBoundary ? {
            master_before: entry.remoteMasterBefore,
            master_after: finalMaster,
          } : {}),
        };
        if (result.brief_id) readyRow.brief_id = result.brief_id;
        if (result.restaffed) readyRow.restaffed = result.restaffed;

        flight.ready.push(readyRow);
        writeDispatchReceipt(flight, receiptPath, { ids, reviewOnly, enforceRemoteBoundary });
        const verificationCommit = String(reviewChange.source_commit || reviewChange.commit || reviewChange.head || '').trim();
        const verificationCitation = verificationCommit
          ? ` Verification snapshot: commit ${verificationCommit}${reviewChange.dirty ? ' with a worktree diff' : ''}; ${landed.check} passed (exit 0).`
          : ` Verification snapshot: the worktree diff was present; ${landed.check} passed (exit 0).`;
        const validatorCitation = validatorResult
          ? ` Independent validator ${validatorResult.engine} signed off: ${validatorResult.reason}.`
          : '';
        const readyResult = cli([
          'task', 'ready', entry.taskId,
          '--proof', `Built by ${activeEngine} engine via one-lap dispatch.${restaffProof} Preserved in isolated worktree ${reviewWorktreePath}. Check re-run: ${landed.check}.${verificationCitation}${validatorCitation} Verify output: ${verifyTail || '(command produced no output, exit 0)'}. Receipt saved at ${path.relative(root, receiptPath)}.`,
          '--result', 'Operators can review a completed, verified change before it lands, reducing the risk of unreviewed changes reaching users.',
          '--landing', 'Operators can review the verified change before it reaches users, reducing the risk of an unreviewed release.',
          '--checked', `${landed.check} passed in the isolated worktree`,
          '--tested', 'The requested behavior passed its declared verifier.',
          '--as', readyActor,
        ]);
        if (!readyResult || readyResult.status !== 0) {
          flight.ready.splice(flight.ready.indexOf(readyRow), 1);
          flight.paused.push({
            task: entry.taskId,
            engine: activeEngine,
            stage: 'task_ready',
            detail: headTail(String(readyResult && (readyResult.stderr || readyResult.stdout) || 'task ready failed')),
            check: landed.check,
            verifier_result: landed.verifier_result,
            worktree: reviewWorktreePath,
            change: reviewChange,
          });
          writeDispatchReceipt(flight, receiptPath, { ids, reviewOnly, enforceRemoteBoundary });
          stampDispatchBrief(root, result.brief_id, 'partial', `verified ${entry.taskId}, but task ready failed`);
          log(`    paused ${entry.taskId} at task_ready - worktree kept`);
          continue;
        }
        readyRow.review_recorded = true;
        stampDispatchBrief(root, result.brief_id, 'pass', `verified ${entry.taskId} for Review`);
        log(`    proof ready ${entry.taskId}`);
        continue;
      }
      const landedRow = { task: entry.taskId, engine: activeEngine, check: landed.check };
      landedRow.verifier_result = landed.verifier_result;
      if (result.brief_id) landedRow.brief_id = result.brief_id;
      if (result.restaffed) landedRow.restaffed = result.restaffed;
      flight.landed.push(landedRow);
      stampDispatchBrief(root, result.brief_id, 'pass', `landed ${entry.taskId} via engine dispatch`);
      cli([
        'task', 'ready', entry.taskId,
        '--proof', `Built by ${activeEngine} engine via atris engine dispatch.${restaffProof} Landed via worktree ship gate (rebase-before-ship, verify re-run). Check re-run: ${landed.check}. Verify output: ${verifyTail || '(command produced no output, exit 0)'}. Receipt saved at ${path.relative(root, receiptPath)}.`,
        '--result', 'Operators can now review engine-built work faster because dispatch reran the verifier before landing.',
        '--landing', 'The verified change is on master and ready for review.',
        '--checked', `${landed.check} passed before landing`,
        '--tested', 'The requested behavior passed its declared verifier.',
        '--as', readyActor,
      ]);
      log(`    ✓ landed ${entry.taskId}`);
    } else {
      flight.paused.push({
        task: entry.taskId,
        engine: activeEngine,
        worktree: entry.worktreePath,
        ...(result.restaffed ? { restaffed: result.restaffed } : {}),
        ...landed,
      });
      stampDispatchBrief(root, result.brief_id, 'partial', `paused ${entry.taskId} at ${landed.stage || 'landing'}`);
      log(`    ⏸ paused ${entry.taskId} at ${landed.stage}${pausedPathsSuffix(landed)} — worktree kept`);
    }
  }

  releasePausedClaimsWithoutWork(cli, {
    paused: flight.paused,
    worktreeByTask: new Map(prepared.map((entry) => [String(entry.taskId), entry.worktreePath])),
    actorByTask: new Map(ids.map((taskId) => [String(taskId), taskActor])),
    baseRef: landTarget,
    log,
  });

  flight.status = flight.paused.length ? 'failed' : 'completed';
  flight.finished_at = new Date().toISOString();
  writeDispatchReceipt(flight, receiptPath, { ids, reviewOnly, enforceRemoteBoundary });
  log('');
  if (engine === 'fable' && flight.paused.length) {
    const paused = flight.paused[0];
    const failed = results.find(({ entry }) => entry.taskId === paused.task);
    const cause = plainDispatchFailureCause(failed && failed.result, paused);
    log(`  fable handoff failed: ${cause}. receipt: ${path.relative(root, receiptPath)}`);
  }
  const completedLabel = reviewOnly ? `${flight.ready.length} proof ready` : `${flight.landed.length} landed`;
  log(`  dispatch over: ${completedLabel}, ${flight.paused.length} paused - receipt: ${path.relative(root, flight.receipt)}`);
  log('');
  return flight;
}
