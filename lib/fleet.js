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
const { spawnSync } = require('child_process');
const {
  appendBriefRecord,
  mirrorBriefRecord,
  stampBriefOutcome,
  worktreeBaseRef,
} = require('./brief-ledger');
const { RUNNER_PROFILE_DEFS, buildRunnerCommand } = require('./runner-command');
const { resolveDefaultVerifier } = require('./default-verifier');
const {
  buildOneLapValidatorPrompt,
  parseOneLapValidatorVerdict,
} = require('./one-lap-validator');
const { listWorktrees } = require('../commands/worktree');

// Lanes a fleet may never staff on its own: the human keeps irreversible
// calls. Mirrors the autoland denied lanes.
const DENIED_TAGS = ['billing', 'deploy', 'security', 'customer', 'external', 'feedback'];

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
    '- Run git status first. Stage ONLY files you changed. Never revert or touch files another agent modified.',
    '- Include or update a focused regression test; run it with npm run test:fast && node --test <focused files> before committing.',
    `- ${commitRule}`,
    ...METHOD_KERNEL.map((rule) => `- ${rule}`),
    '',
    'Final report (plain text): files changed, test command + result, commit sha (or say the commit failed and why).'
  );
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

function buildEngineCommand(engineName, promptFile, { yolo = false, sealed = false, allowedTools = FLEET_ALLOWED_TOOLS } = {}) {
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
    if (sealed && engineName === 'claude') {
      cmd = `${cmd} --safe-mode --no-session-persistence --permission-mode acceptEdits --settings '${JSON.stringify({ sandbox: { enabled: true, autoAllowBashIfSandboxed: true } })}'`;
    }
    if (sealed && engineName === 'cursor') cmd = `${cmd} --sandbox enabled`;
    if (sealed && engineName === 'devin') return cmd.replace(/^devin -p /, 'devin -p --sandbox --permission-mode accept-edits ');
    if (sealed && engineName === 'grok') {
      cmd = `${cmd.replace(/\s+--always-approve\b/, '')} --sandbox enabled --permission-mode acceptEdits --no-memory --no-subagents`;
    }
    if (engineName === 'devin') return cmd.replace(/^devin -p /, 'devin -p --permission-mode dangerous ');
    if (yolo && engineName === 'codex') cmd = cmd.replace(/\bexec\b/, `exec ${YOLO_ENGINE_FLAGS.codex}`);
    if (yolo && engineName === 'claude') cmd = `${cmd} ${YOLO_ENGINE_FLAGS.claude}`;
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

function runInReapedProcessGroup(executable, args, options, controlDir, statusFile) {
  if (!controlDir || !statusFile) throw new Error('sealed execution requires isolated control and status paths');
  const supervisor = path.join(controlDir, 'sandbox-supervisor.js');
  const stateFile = path.join(controlDir, 'sandbox-process.json');
  const leaseFile = path.join(controlDir, 'sandbox-process.lease');
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
  let result;
  try {
    result = spawnSync(process.execPath, [supervisor, stateFile, leaseFile, statusFile, executable, ...args], options);
  } finally {
    terminateSameSandboxProfile(executable, args, options);
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
  if (!result || typeof result !== 'object') return 0;
  if (Object.prototype.hasOwnProperty.call(result, 'exitCode')) return result.exitCode;
  if (Object.prototype.hasOwnProperty.call(result, 'status')) return result.status;
  return 0;
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
  const exitCode = dispatchResultExitCode(result);
  if (exitCode === 0) return null;
  const output = dispatchResultOutput(result).toLowerCase();
  const pattern = DEAD_ENGINE_OUTPUT_PATTERNS.find((p) => output.includes(p));
  if (pattern) return { reason: 'usage_limit', pattern };
  return { reason: 'nonzero_exit', exitCode };
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

function nextInstalledFleetEngine(current, { root = process.cwd(), installedEngines = null } = {}) {
  const engines = installedEngines ? normalizeInstalledEngines(installedEngines) : installedFleetEngines(root);
  const currentName = String(current || '').trim();
  if (!engines.length) return '';
  const index = engines.indexOf(currentName);
  const ordered = index === -1
    ? engines
    : [...engines.slice(index + 1), ...engines.slice(0, index)];
  return ordered.find((name) => name && name !== currentName) || '';
}

function normalizeDispatchResult(result, engineName) {
  const normalized = { ...(result || {}) };
  normalized.engine = normalized.engine || engineName;
  normalized.exitCode = dispatchResultExitCode(normalized);
  return normalized;
}

async function dispatchEntryWithRestaff({
  entry,
  engine,
  root,
  dispatch,
  installedEngines = null,
  restaffState,
}) {
  const runOnce = async (engineName) => {
    const prompt = entry.prompt || buildFleetPrompt(entry.task, { worktreePath: entry.worktreePath, yolo: entry.yolo });
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
  return { ...fallbackResult, restaffed: { from: engine, to: fallback, reason: deadEngine.reason } };
}

// Run one engine on one task in one worktree. Blocking; the conductor runs
// dispatches in parallel via child processes, not threads. `runner` is
// injectable for tests. `prompt` is injectable too: a caller-supplied prompt
// (e.g. `atris engine dispatch --prompt-file`) skips the generated
// buildFleetPrompt text entirely.
function dispatchToEngine({ task, engine, worktreePath, root = process.cwd(), timeoutMs = 900000, runner = null, prompt: promptOverride = '', yolo = false, sealed = false, briefId = '', skipBriefCapture = false, environment = null, allowedTools = FLEET_ALLOWED_TOOLS }) {
  assertIsolatedWorktree(worktreePath, root);
  const prompt = promptOverride || buildFleetPrompt(task, { worktreePath, yolo });
  let capturedBriefId = briefId;
  if (!skipBriefCapture) {
    capturedBriefId = captureDispatchBrief({ root, task, engine, worktreePath, prompt, yolo }).brief_id;
  }
  const runtimeDir = String(environment && environment.ATRIS_ONE_LAP_RUNTIME_DIR || '');
  const promptFile = path.join(sealed && runtimeDir ? runtimeDir : path.join(worktreePath, '.atris'), `fleet-prompt-${task.display_id || 'task'}.md`);
  fs.mkdirSync(path.dirname(promptFile), { recursive: true });
  fs.writeFileSync(promptFile, prompt);
  const command = buildEngineCommand(engine, promptFile, { yolo, sealed, allowedTools });
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
    try {
      const executable = sandboxProfile ? '/usr/bin/sandbox-exec' : 'sh';
      const args = sandboxProfile
        ? ['-p', sandboxProfile, lifecycleWrapper, '/bin/sh', '-c', cmd]
        : ['-c', cmd];
      const spawnOptions = {
        cwd: worktreePath,
        env: childEnv,
        encoding: 'utf8',
        timeout: timeoutMs,
      };
      return sandboxProfile
        ? runInReapedProcessGroup(executable, args, spawnOptions, cleanupControlDir, statusFile)
        : spawnSync(executable, args, spawnOptions);
    } finally {
      if (cleanupRuntimeDir) fs.rmSync(cleanupRuntimeDir, { recursive: true, force: true });
      if (cleanupControlDir) fs.rmSync(cleanupControlDir, { recursive: true, force: true });
    }
  });
  const result = exec(command);
  return {
    task: task.display_id || task.id,
    engine,
    worktreePath,
    promptFile,
    brief_id: capturedBriefId || null,
    command,
    exitCode: result.status,
    report: String(result.stdout || '').slice(-8000),
    stderr: String(result.stderr || '').slice(-2000),
  };
}

// ---------------------------------------------------------------------------
// T2 — staffing

function taskTags(task) {
  const fromTags = Array.isArray(task.tags) ? task.tags : [];
  const fromTag = task && task.tag ? [task.tag] : [];
  // Tags added after creation live in metadata.tags (`atris task tag`); a
  // fleet that only read task.tags/title hashtags would ignore an owner-hold
  // flag stamped on a live task and keep restaffing it (CLI-879).
  const fromMeta = task && task.metadata && Array.isArray(task.metadata.tags) ? task.metadata.tags : [];
  const fromTitle = (String(task.title || '').match(/#([a-z0-9-]+)/gi) || []).map((t) => t.slice(1));
  return [...fromTag, ...fromTags, ...fromMeta, ...fromTitle].map((t) => String(t).toLowerCase());
}

// A task flagged for a human decision is never fleet-staffable, whatever its
// lane. Mirrors the sweep's needs-human hold so both loops agree.
function isHumanHoldTag(tag) {
  const normalized = String(tag).trim().toLowerCase().replace(/_/g, '-');
  return normalized === 'needs-human' || normalized === 'needshuman';
}

function isSafeLane(task) {
  const tags = taskTags(task);
  if (tags.some(isHumanHoldTag)) return false;
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
// Fleet landings always target master. Without the explicit --target, ship
// falls back to the launcher branch's atris-base — a flight launched from a
// feature-branch checkout would merge PRs into that branch while the receipt
// and land board define "landed" as in-master (PRs #207/#208, 2026-07-04).
function fleetShipArgs(entry, check) {
  return [
    'worktree', 'ship',
    '--message', `${String(entry.task.title || '').split(/[.:]/)[0].slice(0, 90)} (${entry.task.display_id}, built by ${entry.engine})`,
    '--verify', check,
    '--target', 'origin/master',
    '--merge',
  ];
}

function landArrival({ worktreePath, git = null }) {
  const run = git || ((args) => spawnSync('git', args, { cwd: worktreePath, encoding: 'utf8' }));
  const fetch = run(['fetch', 'origin']);
  if (fetch.status !== 0) return { ok: false, stage: 'fetch', detail: String(fetch.stderr || '').trim() };
  const rebase = run(['rebase', 'origin/master']);
  if (rebase.status !== 0) {
    const conflicted = run(['diff', '--name-only', '--diff-filter=U']);
    run(['rebase', '--abort']);
    return {
      ok: false,
      stage: 'rebase_conflict',
      conflicts: String(conflicted.stdout || '').trim().split('\n').filter(Boolean),
    };
  }
  return { ok: true, stage: 'rebased' };
}

module.exports = {
  DENIED_TAGS,
  DEAD_ENGINE_OUTPUT_PATTERNS,
  get FLEET_CAPABLE() { return FLEET_CAPABLE; },
  get runFleetFlight() { return runFleetFlight; },
  get focusedCheck() { return focusedCheck; },
  get dispatchCheck() { return dispatchCheck; },
  get runDispatchFlight() { return runDispatchFlight; },
  YOLO_ENGINE_FLAGS,
  DISPATCH_SELF_LAND_TARGET,
  parseDoneCheck,
  METHOD_KERNEL,
  buildFleetPrompt,
  assertIsolatedWorktree,
  buildEngineCommand,
  isSafeLane,
  taskTags,
  detectDeadEngineDispatch,
  nextInstalledFleetEngine,
  dispatchToEngine,
  taskTags,
  isHumanHoldTag,
  isSafeLane,
  fileSurface,
  surfacesOverlap,
  staffFlight,
  assignEngines,
  landArrival,
  fleetShipArgs,
  defaultSelfLandCheck,
};

// ---------------------------------------------------------------------------
// T4 — the conductor: one flight, watchable, receipted

// Engines that can edit a repo headlessly. atris-fast (ax) is a chat lane,
// not a repo worker — it keeps owning normal mission ticks, not fleet builds.
const FLEET_CAPABLE = ['claude', 'codex', 'cursor', 'devin', 'grok'];

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
    ANTHROPIC_API_KEY: selectedSecret(['claude'], 'ANTHROPIC_API_KEY'),
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
  for (const key of [
    'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'NO_COLOR', 'USER', 'LOGNAME', 'SHELL',
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
    'NODE_EXTRA_CA_CERTS', 'NODE_NO_WARNINGS', 'DISABLE_AUTOUPDATER',
    'ATRIS_ENGINE_MODE', 'ATRIS_ENGINE_DELAY', 'ATRIS_ENGINE_COUNT', 'ATRIS_ENGINE_PROMPT',
    'ATRIS_VALIDATOR_MODE', 'ATRIS_VALIDATOR_COUNT', 'ATRIS_VALIDATOR_PROMPT',
    'ATRIS_PUSH_RESULT', 'ATRIS_PUSH_URL', 'ATRIS_PUSH_CONFIG', 'ATRIS_BOUNDARY_DUMP',
    'ATRIS_REAL_GIT', 'ATRIS_TASKS_DB',
  ]) {
    if (process.env[key] !== undefined) environment[key] = String(process.env[key]);
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
  const conductorEntry = /^\?\? \.atris\/(?:agent-worktree\.json|state\/briefs\.jsonl)$/;
  const dirty = String(status.stdout || '').trim().split(/\r?\n/).filter(Boolean)
    .filter((line) => !conductorEntry.test(line));
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
  const fail = (stage, detail, extra = {}) => ({ ok: false, stage, detail: String(detail || '').trim().slice(-500), ...extra });
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
  const conductorEntries = /^\?\? \.atris\/(?:agent-worktree\.json|fleet-prompt-[^/]+\.md|runtime-tmp(?:\/.*)?|state\/briefs\.jsonl)$/;
  const uncommitted = dirtyEntries.filter((line) => !conductorEntries.test(line));
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
  const conductorEntry = /^\?\? \.atris\/(?:agent-worktree\.json|state\/briefs\.jsonl)$/;
  const dirty = String(status.stdout || '').trim().split('\n').filter(Boolean)
    .filter((line) => !conductorEntry.test(line));
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
      validatorResult.reason = String(dispatched.stderr || verdict.reason || `validator exited ${exitCode}`).trim().slice(-500);
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

function writeDispatchReceipt(flight, receiptPath, resultOptions) {
  flight.result = dispatchReceiptResult(flight, resultOptions);
  flight.receipt = receiptPath;
  fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
  const tempPath = `${receiptPath}.tmp-${process.pid}`;
  fs.writeFileSync(tempPath, `${JSON.stringify(flight, null, 2)}\n`);
  fs.renameSync(tempPath, receiptPath);
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

function defaultSelfLandCheck({ worktreePath, targetRef = DISPATCH_SELF_LAND_TARGET, git = null } = {}) {
  const run = git || ((args) => spawnSync('git', args, { cwd: worktreePath, encoding: 'utf8' }));
  const branch = String(targetRef || '').startsWith('origin/') ? String(targetRef).slice('origin/'.length) : '';
  const fetch = run(branch ? ['fetch', 'origin', `${branch}:refs/remotes/origin/${branch}`] : ['fetch', 'origin']);
  if (fetch.status !== 0) {
    return { ok: false, stage: 'self_land_check', target: targetRef, detail: String(fetch.stderr || fetch.stdout || '').trim() };
  }
  const ancestor = run(['merge-base', '--is-ancestor', 'HEAD', targetRef]);
  if (ancestor.status === 0) return { ok: true, stage: 'self_landed', target: targetRef };
  if (ancestor.status === 1) {
    return { ok: false, stage: 'self_land_missing', target: targetRef, detail: `HEAD is not an ancestor of ${targetRef}` };
  }
  return { ok: false, stage: 'self_land_check', target: targetRef, detail: String(ancestor.stderr || ancestor.stdout || '').trim() };
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
  checkoutBase = 'origin/master',
} = {}) {
  const cli = ownCli || defaultOwnCli(root);
  const roster = engines || (() => {
    const { roster: fullRoster } = require('../commands/engine');
    return fullRoster(root).filter((e) => e.installed && FLEET_CAPABLE.includes(e.name)).map((e) => e.name);
  })();

  const staffed = assignEngines(staffFlight(readProjectionTasks(root), { slots }), roster);
  // The receipt path is decided BEFORE landings so each task's ready-proof
  // can cite it — the proof policy certifies receipt-backed proofs agent-side.
  const receiptPath = path.join(root, 'atris', 'runs', `fleet-${nowStamp()}.json`);
  const flight = {
    at: new Date().toISOString(),
    root,
    slots,
    roster,
    staffed: staffed.map((s) => ({ task: s.task.display_id, title: String(s.task.title || '').slice(0, 140), engine: s.engine, surface: s.surface })),
    results: [],
    landed: [],
    paused: [],
  };

  log('');
  log(`  fleet — ${roster.length} engine${roster.length === 1 ? '' : 's'} ready, ${staffed.length} task${staffed.length === 1 ? '' : 's'} staffed`);
  for (const s of staffed) log(`    ${s.engine.padEnd(8)} → ${s.task.display_id}  ${String(s.task.title || '').slice(0, 80)}`);
  log('');

  if (dryRun || staffed.length === 0) {
    flight.dry_run = true;
    return flight;
  }

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
    cli(['task', 'claim', String(entry.task.display_id), '--as', `fleet-${entry.engine}`]);
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
  const land = lander || (({ entry }) => {
    const rebased = landArrival({ worktreePath: entry.worktreePath });
    if (!rebased.ok) return rebased;
    const check = focusedCheck(entry.task) || 'git log -1 --oneline';
    const shipped = cli(fleetShipArgs(entry, check), entry.worktreePath);
    if (shipped.status !== 0 || !/done: worktree shipped/.test(shipped.stdout)) {
      return { ok: false, stage: 'ship', detail: (shipped.stderr || shipped.stdout).slice(-300) };
    }
    return { ok: true, stage: 'shipped' };
  });

  for (const { entry, result } of results) {
    const activeEngine = result.engine || entry.engine;
    const landingEntry = { ...entry, engine: activeEngine };
    if (result.restaffed) log(`    restaffed ${entry.task.display_id}: ${result.restaffed.from} -> ${result.restaffed.to} (${result.restaffed.reason})`);
    if (result.exitCode !== 0) {
      const paused = { task: entry.task.display_id, engine: activeEngine, stage: 'build', detail: (result.stderr || '').slice(0, 200) };
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
        '--proof', `Built by ${activeEngine} engine in fleet flight.${restaffProof} Landed via worktree ship gate (rebase-before-ship, verify re-run). Receipt saved at ${path.relative(root, receiptPath)}. Report tail: ${String(result.report || '').slice(-300).replace(/\n/g, ' ')}`,
        '--result', 'Operators can now review fleet-shipped work faster because the worktree was verified before landing.',
        '--as', `fleet-${activeEngine}`,
      ]);
      log(`    ${activeEngine.padEnd(8)} ✓ landed ${entry.task.display_id}`);
    } else {
      flight.paused.push({ task: entry.task.display_id, engine: activeEngine, ...(result.restaffed ? { restaffed: result.restaffed } : {}), ...landed });
      stampDispatchBrief(root, result.brief_id, 'partial', `paused ${entry.task.display_id} at ${landed.stage || 'landing'}`);
      log(`    ${activeEngine.padEnd(8)} ⏸ paused ${entry.task.display_id} at ${landed.stage}${landed.conflicts ? ` (${landed.conflicts.join(', ')})` : ''} — worktree kept`);
    }
  }

  fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
  flight.receipt = receiptPath;
  fs.writeFileSync(flight.receipt, `${JSON.stringify(flight, null, 2)}\n`);
  log('');
  log(`  flight over: ${flight.landed.length} landed, ${flight.paused.length} paused · receipt: ${path.relative(root, flight.receipt)}`);
  log('');
  return flight;
}

// ---------------------------------------------------------------------------
// T5 — one-command dispatch: `atris engine dispatch <task-id> --engine <name>`

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
  checkoutBase = 'origin/master',
  installedEngines = null,
  selfLandCheck = null,
  yolo = false,
  reviewOnly = false,
  verifierCommand = '',
  receiptContext = null,
  actor = '',
  changeInspector = null,
  validatorEngines = null,
  validatorDispatcher = null,
  validatorStateInspector = null,
} = {}) {
  if (!engine) throw new Error('runDispatchFlight: engine is required');
  if (!FLEET_CAPABLE.includes(engine)) {
    throw new Error(`runDispatchFlight: engine "${engine}" cannot build headlessly (capable: ${FLEET_CAPABLE.join(', ')})`);
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
  const verify = verifier || (trustedVerifier ? defaultTrustedVerifyRunner : defaultVerifyRunner);
  const inspectChange = changeInspector || inspectReviewChange;
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

  log('');
  log(`  dispatch — ${ids.length} task${ids.length === 1 ? '' : 's'} -> ${engine}`);
  log('');

  // Same rule as the fleet: dispatch worktrees cut from origin/master by
  // default so rebase-before-ship never replays a launcher feature branch.
  const startBaseArgs = checkoutBase ? ['--base', checkoutBase] : [];
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
    let landingWorktreePath = '';
    let remoteBoundary = null;
    if (enforceRemoteBoundary) {
      remoteBoundary = prepareReviewSandbox({ root, taskId, engine });
    } else {
      const started = cli(['worktree', 'start', '--agent', engine, '--task', `dispatch-${taskId.toLowerCase()}`, ...startBaseArgs]);
      const wt = (started.stdout.match(/next: cd (.+)/) || [])[1];
      if (!wt) {
        flight.paused.push({ task: taskId, stage: 'worktree_start', detail: String(started.stderr || '').slice(0, 200) });
        log(`    ✗ ${taskId} worktree start failed`);
        continue;
      }
      landingWorktreePath = wt.trim();
    }
    if (enforceRemoteBoundary && (!remoteBoundary || remoteBoundary.ok !== true)) {
      flight.paused.push({
        task: taskId,
        stage: 'remote_quarantine',
        detail: String(remoteBoundary && remoteBoundary.detail || 'could not prepare a sealed review sandbox').slice(-500),
        worktree: null,
      });
      log(`    paused ${taskId} because its sealed review sandbox could not be prepared`);
      continue;
    }
    const worktreePath = enforceRemoteBoundary ? remoteBoundary.worktreePath : landingWorktreePath;
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
      ...(trustedPrompt ? { prompt: trustedPrompt } : {}),
    });
    log(`    building ${taskId} in ${path.basename(worktreePath)}`);
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
    }));
  }));
  const restaffState = { used: false };

  const results = await Promise.all(prepared.map((entry) =>
    dispatchEntryWithRestaff({
      entry,
      engine: entry.engine,
      root,
      dispatch,
      installedEngines,
      restaffState,
    }).then((result) => ({
      entry,
      result,
      candidate: enforceRemoteBoundary && result.exitCode === 0
        ? reviewCandidateSnapshot(entry.remoteBoundary)
        : null,
    }))
  ));
  flight.results = results.map(({ entry, result, candidate }) => {
    const row = { task: entry.taskId, engine: result.engine || entry.engine, exitCode: result.exitCode };
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
    const change = reviewOnly ? inspectChange(entry.worktreePath, checkoutBase || 'origin/master') : null;
    if (reviewOnly && (!change || change.has_change !== true)) {
      return {
        ok: false,
        stage: 'no_change',
        detail: String(change && change.detail || 'the engine produced no committed or worktree diff').slice(-500),
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
        detail: `${verified.stdout}${verified.stderr}`.slice(-500),
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
    const shipped = cli(fleetShipArgs({ task: entry.task, engine: entry.engine || engine }, check), entry.worktreePath);
    if (shipped.status !== 0 || !/done: worktree shipped/.test(shipped.stdout)) {
      return { ok: false, stage: 'ship', detail: (shipped.stderr || shipped.stdout).slice(-500) };
    }
    return {
      ok: true,
      stage: 'shipped',
      check,
      verifyOutput: `${verified.stdout}${verified.stderr}`,
      verifier_result: verifierResult,
    };
  });

  for (const { entry, result, candidate } of results) {
    const activeEngine = result.engine || entry.engine || engine;
    const readyActor = explicitActor || `fleet-${activeEngine}`;
    const landingEntry = { ...entry, engine: activeEngine, candidate };
    if (result.restaffed) log(`    restaffed ${entry.taskId}: ${result.restaffed.from} -> ${result.restaffed.to} (${result.restaffed.reason})`);
    if (result.exitCode !== 0) {
      const paused = {
        task: entry.taskId,
        engine: activeEngine,
        stage: 'build',
        detail: String(result.stderr || '').slice(0, 300),
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
        detail: String(candidate && candidate.detail || 'the executor candidate could not be frozen').slice(-500),
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
      const selfLanded = checkSelfLand({ entry, result, worktreePath: entry.worktreePath, targetRef: DISPATCH_SELF_LAND_TARGET });
      if (selfLanded.ok) {
        const target = selfLanded.target || DISPATCH_SELF_LAND_TARGET;
        flight.landed.push({
          task: entry.taskId,
          engine: activeEngine,
          landing: 'self',
          target,
          verifier_result: {
            command: `git merge-base --is-ancestor HEAD ${target}`,
            passed: true,
            status: 0,
            output: `HEAD is an ancestor of ${target}`,
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
          target: selfLanded.target || DISPATCH_SELF_LAND_TARGET,
          detail: selfLanded.detail || '',
        });
        stampDispatchBrief(root, result.brief_id, 'partial', `self-land check paused ${entry.taskId} at ${stage}`);
        log(`    ⏸ paused ${entry.taskId} at ${stage}`);
      }
      continue;
    }
    log(`    ${reviewOnly ? 'checking' : 'landing'} ${entry.taskId}...`);
    const landed = land({ entry: landingEntry, result });
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
        const change = landed.change || inspectChange(entry.worktreePath, checkoutBase || 'origin/master');
        if (!change || change.has_change !== true) {
          flight.paused.push({
            task: entry.taskId,
            engine: activeEngine,
            stage: 'no_change',
            detail: String(change && change.detail || 'the engine produced no committed or worktree diff').slice(-500),
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
              detail: String(validatorResult && validatorResult.reason || 'independent validator failed').slice(-500),
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
            detail: String(readyResult && (readyResult.stderr || readyResult.stdout) || 'task ready failed').slice(-500),
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
      log(`    ⏸ paused ${entry.taskId} at ${landed.stage}${landed.conflicts ? ` (${landed.conflicts.join(', ')})` : ''} — worktree kept`);
    }
  }

  writeDispatchReceipt(flight, receiptPath, { ids, reviewOnly, enforceRemoteBoundary });
  log('');
  const completedLabel = reviewOnly ? `${flight.ready.length} proof ready` : `${flight.landed.length} landed`;
  log(`  dispatch over: ${completedLabel}, ${flight.paused.length} paused - receipt: ${path.relative(root, flight.receipt)}`);
  log('');
  return flight;
}
