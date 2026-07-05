'use strict';

// Pulse: the durable overnight self-improvement heartbeat for atris-cli itself.
//
// The /loop skill schedules a heartbeat via Claude Code's CronCreate, but that
// only fires while Claude Code is open and idle and dies with the session. The
// proven overnight pattern is an OS cron (see the commander tick.sh template) —
// it fires regardless of whether Claude Code is running. `atris pulse` brings
// that pattern home: one OS-cron tick that runs the existing mission engine,
// verifies, and writes BOTH a pulse receipt (revives the Pulse AGI loop-health
// channel brain.js watches) and a reward scorecard (revives the feedback signal
// that policy-lessons mines). This module holds the pure, testable core; the
// command (commands/pulse.js) wires it to the engine and the cron shell.

const fs = require('fs');
const path = require('path');
const { DEFAULT_CLAUDE_RUNNER_MODEL } = require('./runner-command');

const PULSE_RECEIPT_SCHEMA = 'atris.pulse_tick.v1';
// Reuse the improve-tick scorecard schema so the brain + policy-lessons see
// pulse reward as fresh feedback signal (source:'pulse' keeps it attributable).
const SCORECARD_SCHEMA = 'atris.improve_tick.v1';
const PULSE_MARKER = 'ATRIS_PULSE_SELF_IMPROVE';
// Hourly at an off-clock minute (avoid :00/:30 fleet sync). Each tick spawns a
// real worker + full verify, so default conservative; raise with --cadence.
const DEFAULT_CADENCE_CRON = '23 * * * *';
// Lock-steal timeout: a tick still holding the lock after 30m is hung → steal it.
const STALE_TICK_MS = 30 * 60 * 1000;
// Liveness timeout: how long since the last finished tick before the loop reads
// as "stale" (stopped firing). Must exceed the cadence or it flaps stale between
// every tick — default cadence is hourly, so allow ~2 missed ticks before alarm.
const LIVENESS_STALE_MS = 150 * 60 * 1000;

function stateDir(root) {
  return path.join(root, '.atris', 'state');
}
function pulseReceiptsPath(root) {
  return path.join(stateDir(root), 'pulse_agi_loop_receipts.jsonl');
}
function scorecardsPath(root) {
  return path.join(stateDir(root), 'scorecards.jsonl');
}
function pulseCounterPath(root) {
  return path.join(stateDir(root), 'pulse.tick-count');
}
function pulseLockDir(root) {
  return path.join(stateDir(root), 'pulse.lock');
}

// --- receipt + scorecard building (pure) ---

function buildPulseReceipt(input = {}) {
  return {
    schema: PULSE_RECEIPT_SCHEMA,
    ts: input.ts || new Date().toISOString(),
    tick_index: input.tickIndex != null ? input.tickIndex : null,
    phase: input.phase || 'finished', // 'started' | 'finished'
    actor: input.actor || null, // 'mission_run_due' | 'noop' | ...
    actor_ok: input.actorOk != null ? input.actorOk : null,
    actor_reason: input.actorReason || null, // 'completed' | 'no_due_mission' | 'error'
    verify_cmd: input.verifyCmd || null,
    verify_passed: input.verifyPassed != null ? input.verifyPassed : null,
    // Why the verifier didn't pass (output tail, or 'verifier_missing' note) —
    // a bare verify_passed:false made every red tick a manual re-run to diagnose.
    verify_detail: input.verifyDetail || null,
    changed_files: Array.isArray(input.changedFiles) ? input.changedFiles : [],
    what: input.what || null,
    // Last words of a failed actor (stderr/stdout tail). Without this every
    // failure reads as a bare "error" and diagnosing means re-running by hand.
    actor_detail: input.actorDetail || null,
    elapsed_ms: input.elapsedMs != null ? input.elapsedMs : null,
    prev_tick_stale: input.prevTickStale != null ? input.prevTickStale : false,
    reward: input.reward != null ? input.reward : null,
  };
}

// The loop's own paper trail. Receipts, state rows, and journal lines are
// written by every tick as bookkeeping — counting them as "work produced"
// makes a do-nothing tick look productive, which then runs the verifier and
// (when it fails) punishes the tick for having done nothing but exist.
const LOOP_BOOKKEEPING_RE = /^(?:\.atris\/|atris\/(?:runs|logs|status)\/)/;

// Diff before/after snapshots of every checkout ({path: {head, dirty: []}}).
// A worktree present only in `after` was created BY the tick — all its dirt is
// the tick's contribution. Files outside the main root are labeled with their
// checkout's basename so receipts stay readable.
function diffWorkspaceSnapshots(mainRoot, before = {}, after = {}) {
  const changedFiles = [];
  const changedRoots = [];
  let committed = false;
  for (const root of Object.keys(after)) {
    const a = after[root] || {};
    const b = before[root];
    const priorDirty = new Set((b && b.dirty) || []);
    const newFiles = (a.dirty || [])
      .filter((f) => !priorDirty.has(f))
      .filter((f) => !LOOP_BOOKKEEPING_RE.test(f));
    const didCommit = Boolean(b && b.head && a.head && b.head !== a.head);
    if (didCommit) committed = true;
    if (didCommit || newFiles.length) changedRoots.push(root);
    const prefix = root === mainRoot ? '' : `${String(root).split('/').filter(Boolean).pop()}:`;
    for (const file of newFiles) changedFiles.push(`${prefix}${file}`);
  }
  return { changedFiles, committed, changedRoots };
}

// A verifier that cannot run is not a verifier that failed. npm prints
// "Missing script: test" in a workspace with no test script — punishing every
// work-producing tick with -1 there turns the reward channel into pure noise
// (the loop "learns" that doing nothing is optimal).
function verifyOutcome({ status, stdout, stderr } = {}) {
  const combined = `${String(stderr || '')}\n${String(stdout || '')}`;
  if (/missing script:\s*"?test"?/i.test(combined) || /npm error missing script/i.test(combined)) {
    return {
      passed: null,
      reason: 'verifier_missing',
      detail: 'workspace has no test script for this verify command — configure one with pulse install --verify',
    };
  }
  const detail = status === 0 ? null : (combined.trim().slice(-300).trim() || null);
  return { passed: status === 0, reason: status === 0 ? 'verify_passed' : 'verify_failed', detail };
}

// One heartbeat per WORKSPACE, not one per machine. The state home and cron
// marker used to be global singletons: installing pulse from a second repo
// overwrote the first repo's tick.sh (observed live: the script's ROOT
// flip-flopped between checkouts on consecutive nights) and the crontab
// dedupe silently killed the first heartbeat. Scope both by workspace key.
function pulseWorkspaceKey(root) {
  const base = String(root || '').split('/').filter(Boolean).pop() || 'workspace';
  return base.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'workspace';
}

function pulseWorkspaceMarker(root) {
  return `${PULSE_MARKER}:${pulseWorkspaceKey(root)}`;
}

// Legacy singleton lines end in the bare marker; scoped lines carry a
// workspace suffix. Installs/uninstalls must remove their own scoped line and
// any legacy bare line (which pointed at the shared, fought-over script) while
// leaving other workspaces' heartbeats alone.
function crontabLineBelongsToWorkspace(line, root) {
  const text = String(line || '');
  if (text.includes(pulseWorkspaceMarker(root))) return true;
  return new RegExp(`#\\s*${PULSE_MARKER}\\s*$`).test(text);
}

// One bounded front-door autopilot leg that finishes INSIDE the caller's spawn
// timeout. The front autopilot ignores the legacy --auto/--iterations flags
// and loops until stopped — under a spawnSync timeout that meant productive
// legs were SIGTERMed mid-work at exactly timeoutMs and scored as errors
// (observed: a leg with 4 tick-ok mission ticks killed at 600s, reward 0).
function autopilotTickArgs(timeoutMs = 600000) {
  const legWallSeconds = Math.max(60, Math.floor(timeoutMs / 1000) - 120);
  return ['autopilot', '--once', '--leg-wall', String(legWallSeconds)];
}

// Turn a failed engine spawn into an actionable reason + a short detail tail,
// instead of the bare 'error' that buried every root cause tonight (logged-out
// claude, stale lock, autopilot bail-out all looked identical in receipts).
function classifyActorFailure({ status, signal, stdout, stderr } = {}) {
  const out = String(stdout || '');
  const err = String(stderr || '');
  const combined = `${err}\n${out}`;
  let reason = 'error';
  if (signal && status == null) {
    reason = 'timeout'; // spawnSync timeout kills with a signal and a null status
  } else if (/not logged in|please run \/login|not authenticated|please log in|login required|auth(?:entication)? expired/i.test(combined)) {
    reason = 'auth-required';
  }
  const detail = (err.trim() || out.trim()).slice(-300).trim() || null;
  return { reason, detail };
}

function buildPulseScorecardRow(input = {}) {
  return {
    schema: SCORECARD_SCHEMA,
    ts: input.ts || new Date().toISOString(),
    source: 'pulse',
    member: 'pulse',
    mode: input.mode || 'tick',
    reward: input.reward != null ? input.reward : 0,
    verify_passed: input.verifyPassed != null ? input.verifyPassed : null,
    credits_deducted: 0,
    what_shipped: input.what || null,
    files_written: Array.isArray(input.changedFiles) ? input.changedFiles : [],
    model_used: input.model || null,
    task_id: input.taskId || null,
    elapsed_ms: input.elapsedMs != null ? input.elapsedMs : null,
  };
}

function buildInterruptedPulseReceipt(input = {}) {
  const signal = input.signal || 'signal';
  return buildPulseReceipt({
    tickIndex: input.tickIndex,
    phase: 'finished',
    actor: 'pulse_signal',
    actorOk: false,
    actorReason: String(signal).toLowerCase(),
    what: `tick interrupted by ${signal}`,
    elapsedMs: input.startedAt ? Date.now() - input.startedAt : input.elapsedMs,
    prevTickStale: input.prevTickStale,
    reward: -1,
  });
}

// The heartbeat's full composition (mirrors the /loop skill): run the due
// mission to continue an existing goal; if none is due, fall back to an
// autopilot tick — that path is where proposeCandidateHorizons AUTHORS a new
// goal at an endgame boundary. The fallback needs a worker, so skip it under
// --no-claude (goal-authoring can't happen without the model in the loop).
function shouldFallbackToAutopilot({ missionReason, autopilotFallback = true, noClaude = false } = {}) {
  if (!autopilotFallback) return false;
  if (noClaude) return false;
  return missionReason === 'no_due_mission';
}

// Reward gating mirrors the improve.js tick-5 lesson: only verified,
// work-producing ticks earn positive reward; verify failure is punished;
// a tick that produced no work scores 0. `producedWork` MUST be the tick's
// actual delta (new commit or newly-dirtied files), never the whole dirty tree —
// crediting pre-existing dirt re-rewards the same change every tick (the reward
// inflation bug). The caller computes producedWork from a before/after snapshot.
function scoreTick({ verifyPassed, producedWork } = {}) {
  if (verifyPassed === false) return -1;
  if (!producedWork) return 0;
  return verifyPassed === true ? 1 : 0;
}

// Only write a scorecard when there is signal. A pure no-op tick still leaves a
// pulse receipt (for liveness) but must not spam the reward channel with noise.
function shouldWriteScorecard({ reward } = {}) {
  return reward !== 0;
}

// --- ghost / stale detection (pure) ---

// Pair started+finished by tick_index; any 'started' with no 'finished' partner
// is a tick that crashed mid-run — exactly the silent-runner-death failure mode.
function findOrphanStarts(receipts) {
  if (!Array.isArray(receipts)) return [];
  const finished = new Set();
  for (const r of receipts) {
    if (r && r.phase === 'finished' && r.tick_index != null) finished.add(r.tick_index);
  }
  const orphans = [];
  for (const r of receipts) {
    if (r && r.phase === 'started' && r.tick_index != null && !finished.has(r.tick_index)) {
      orphans.push(r.tick_index);
    }
  }
  return orphans;
}

// Liveness reflects the LATEST tick only. A historical orphan (a crash that was
// later recovered by a finished tick) is surfaced in the feed via
// findOrphanStarts, but must NOT make a recovered loop read as dead forever.
function detectStaleTick(receipts, now = Date.now(), staleMs = LIVENESS_STALE_MS) {
  if (!Array.isArray(receipts) || receipts.length === 0) {
    return { stale: false, reason: 'no_receipts' };
  }
  const last = receipts[receipts.length - 1];
  if (last && last.phase === 'started') {
    // the most recent thing we did was start a tick that never finished
    return { stale: true, reason: 'started_without_finish', tick_index: last.tick_index };
  }
  const lastMs = Date.parse(last && last.ts ? last.ts : '');
  if (Number.isFinite(lastMs) && now - lastMs > staleMs) {
    return { stale: true, reason: 'last_tick_too_old', age_ms: now - lastMs };
  }
  return { stale: false, reason: 'fresh' };
}

// --- summarize (pure) ---

function summarizePulse(receipts, now = Date.now()) {
  const all = Array.isArray(receipts) ? receipts : [];
  const finished = all.filter((r) => r && r.phase === 'finished');
  const rewardSum = finished.reduce((a, r) => a + (Number(r.reward) || 0), 0);
  const last = finished.length ? finished[finished.length - 1] : null;
  return {
    total_ticks: finished.length,
    reward_sum: rewardSum,
    verify_pass: finished.filter((r) => r.verify_passed === true).length,
    verify_fail: finished.filter((r) => r.verify_passed === false).length,
    last_tick_ts: last ? last.ts : null,
    last_verify_passed: last ? last.verify_passed : null,
    orphan_ticks: findOrphanStarts(all),
    stale: detectStaleTick(all, now),
  };
}

// --- IO helpers ---

function appendJsonl(file, row) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(row)}\n`, 'utf8');
  return file;
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // skip foreign / partial rows
    }
  }
  return out;
}

function shellSingleQuote(value) {
  return `'${String(value || '').replace(/'/g, "'\\''")}'`;
}

function normalizeCronCadence(value = DEFAULT_CADENCE_CRON) {
  const raw = String(value || DEFAULT_CADENCE_CRON).trim();
  if (!raw) return DEFAULT_CADENCE_CRON;
  if (raw.toLowerCase() === 'hourly') return DEFAULT_CADENCE_CRON;
  if (raw.toLowerCase() === 'daily') return '23 2 * * *';
  if (raw.split(/\s+/).length === 5) return raw;

  const minutes = raw.match(/^(\d+)\s*(m|min|mins|minute|minutes)$/i);
  if (minutes) {
    const n = Number(minutes[1]);
    if (Number.isInteger(n) && n >= 1 && n <= 59) return `*/${n} * * * *`;
    throw new Error(`invalid cadence "${raw}": minute cadence must be 1m-59m or a 5-field cron`);
  }

  const hours = raw.match(/^(\d+)\s*(h|hr|hrs|hour|hours)$/i);
  if (hours) {
    const n = Number(hours[1]);
    if (Number.isInteger(n) && n >= 1 && n <= 23) return `23 */${n} * * *`;
    if (n === 24) return '23 0 * * *';
    throw new Error(`invalid cadence "${raw}": hour cadence must be 1h-24h or a 5-field cron`);
  }

  throw new Error(`invalid cadence "${raw}": use 13m, 2h, hourly, daily, or a 5-field cron`);
}

function normalizeExpiryDuration(input = {}) {
  const hasHours = input.hours !== undefined && input.hours !== null && String(input.hours).trim() !== '';
  if (hasHours) {
    const hours = Number(input.hours);
    if (Number.isFinite(hours) && hours > 0) {
      return {
        source: 'hours',
        hours,
        days: null,
        seconds: Math.ceil(hours * 60 * 60),
      };
    }
    throw new Error(`invalid hours "${input.hours}": use a positive number of hours`);
  }

  const rawDays = input.days === undefined || input.days === null || String(input.days).trim() === ''
    ? 7
    : input.days;
  const days = Number(rawDays);
  if (Number.isFinite(days) && days > 0) {
    return {
      source: 'days',
      hours: null,
      days,
      seconds: Math.ceil(days * 24 * 60 * 60),
    };
  }
  throw new Error(`invalid days "${rawDays}": use a positive number of days`);
}

function runnerEnvAliasExport({ genericName, legacyName, value }) {
  if (!value) return '';
  return [
    `if [ -z "\${${genericName}:-}" ]; then`,
    `  if [ -n "\${${legacyName}:-}" ]; then`,
    `    export ${genericName}="\${${legacyName}}"`,
    '  else',
    `    export ${genericName}=${shellSingleQuote(value)}`,
    '  fi',
    'fi',
    `[ -n "\${${legacyName}:-}" ] || export ${legacyName}="\${${genericName}}"`,
  ].join('\n');
}

function readPulseReceipts(root) {
  return readJsonl(pulseReceiptsPath(root));
}
function appendPulseReceipt(root, receipt) {
  return appendJsonl(pulseReceiptsPath(root), receipt);
}
function appendScorecard(root, row) {
  return appendJsonl(scorecardsPath(root), row);
}

function nextTickIndex(root) {
  const file = pulseCounterPath(root);
  let n = 0;
  try {
    n = parseInt(fs.readFileSync(file, 'utf8').trim(), 10) || 0;
  } catch {}
  n += 1;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, String(n), 'utf8');
  } catch {}
  return n;
}

// Lock prevents overlapping ticks. A lock older than staleMs is stolen (and the
// theft is reported so the orphaned tick surfaces instead of blocking forever).
function acquireLock(root, now = Date.now(), staleMs = STALE_TICK_MS) {
  const dir = pulseLockDir(root);
  // The lock dir itself is created non-recursively (atomic), but its parent
  // (.atris/state) must exist first or a fresh workspace can never acquire it.
  try { fs.mkdirSync(path.dirname(dir), { recursive: true }); } catch {}
  try {
    fs.mkdirSync(dir, { recursive: false });
    try {
      fs.writeFileSync(path.join(dir, 'pid'), String(process.pid), 'utf8');
    } catch {}
    return { acquired: true, stale: false };
  } catch {
    let ageMs = Infinity;
    try {
      ageMs = now - fs.statSync(dir).mtimeMs;
    } catch {}
    if (ageMs > staleMs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        fs.mkdirSync(dir, { recursive: false });
        fs.writeFileSync(path.join(dir, 'pid'), String(process.pid), 'utf8');
        return { acquired: true, stale: true, ageMs };
      } catch {}
    }
    return { acquired: false, stale: false, ageMs };
  }
}

function releaseLock(root) {
  try {
    fs.rmSync(pulseLockDir(root), { recursive: true, force: true });
  } catch {}
}

// --- cron tick script + crontab line (pure string generation) ---

// Minimal shell wrapper modeled on the proven commander tick.sh: deadline
// self-removal, then hand off to `atris pulse tick` (all real logic lives in JS,
// testable, not duplicated in shell). The wrapper only owns scheduling concerns.
function buildTickScript(opts = {}) {
  const {
    root,
    atrisBin = 'atris',
    stateHome,
    deadlineEpoch,
    marker = PULSE_MARKER,
    model = DEFAULT_CLAUDE_RUNNER_MODEL,
    runnerProfile = '',
    runnerBin = '',
    runnerCommandTemplate = '',
    verifyCmd = 'npm test',
    pathDirs = [],
  } = opts;
  if (!root) throw new Error('buildTickScript: root is required');
  if (!stateHome) throw new Error('buildTickScript: stateHome is required');
  if (!deadlineEpoch) throw new Error('buildTickScript: deadlineEpoch is required');
  const safeVerify = String(verifyCmd).replace(/'/g, "'\\''");
  const runnerModelExport = runnerEnvAliasExport({
    genericName: 'ATRIS_RUNNER_MODEL',
    legacyName: 'ATRIS_CLAUDE_MODEL',
    value: model,
  });
  const runnerProfileExport = runnerProfile
    ? `[ -n "\${ATRIS_RUNNER_PROFILE:-}" ] || export ATRIS_RUNNER_PROFILE=${shellSingleQuote(runnerProfile)}`
    : '';
  const runnerBinExport = runnerEnvAliasExport({
    genericName: 'ATRIS_RUNNER_BIN',
    legacyName: 'ATRIS_CLAUDE_BIN',
    value: runnerBin,
  });
  const runnerCommandTemplateExport = runnerEnvAliasExport({
    genericName: 'ATRIS_RUNNER_COMMAND_TEMPLATE',
    legacyName: 'ATRIS_CLAUDE_COMMAND_TEMPLATE',
    value: runnerCommandTemplate,
  });
  // Cron runs with a minimal PATH. The engine spawns `claude`/`node`/`git` by
  // bare name, so we must prepend their real locations or every tick silently
  // fails to spawn the worker (looks alive, never improves). pathDirs are the
  // resolved bin dirs (claude, node, atris, homebrew) discovered at install.
  const dirs = Array.from(new Set([
    ...pathDirs.filter(Boolean),
    '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin',
  ]));
  const pathExport = `export PATH="${dirs.join(':')}:$PATH"`;
  return `#!/bin/zsh
set -u

ROOT="${root}"
ATRIS="${atrisBin}"
STATE="${stateHome}"
LOG_DIR="$STATE/logs"
DEADLINE_EPOCH="${deadlineEpoch}"
MARKER="${marker}"

# Cron has a minimal PATH; restore the dirs the engine's bare-name spawns need.
${pathExport}

mkdir -p "$LOG_DIR"

now="$(date +%s)"
if [ "$now" -ge "$DEADLINE_EPOCH" ]; then
  crontab -l 2>/dev/null | grep -v "$MARKER" | crontab - 2>/dev/null || true
  echo "$(date -Iseconds) pulse expired; removed cron" >> "$LOG_DIR/control.log"
  exit 0
fi

stamp="$(date +"%Y%m%d-%H%M%S")"
log="$LOG_DIR/$stamp.log"

cd "$ROOT" || { echo "$(date -Iseconds) ROOT missing" >> "$LOG_DIR/control.log"; exit 1; }

# Autonomous ticks use the pinned default unless the installer supplied a model.
# Operators can still override per install with --model or env.
${runnerModelExport}
${runnerProfileExport}
${runnerBinExport}
${runnerCommandTemplateExport}
export ATRIS_SKIP_UPDATE_CHECK=1

"$ATRIS" pulse tick --json --verify '${safeVerify}' >> "$log" 2>&1
echo "done: $(date -Iseconds) exit=$?" >> "$log"
`;
}

function buildCrontabLine(opts = {}) {
  const { cron = DEFAULT_CADENCE_CRON, scriptPath, marker = PULSE_MARKER } = opts;
  if (!scriptPath) throw new Error('buildCrontabLine: scriptPath is required');
  return `${normalizeCronCadence(cron)} ${scriptPath} # ${marker}`;
}

module.exports = {
  PULSE_RECEIPT_SCHEMA,
  SCORECARD_SCHEMA,
  PULSE_MARKER,
  DEFAULT_CADENCE_CRON,
  STALE_TICK_MS,
  LIVENESS_STALE_MS,
  stateDir,
  pulseReceiptsPath,
  scorecardsPath,
  pulseCounterPath,
  pulseLockDir,
  buildPulseReceipt,
  classifyActorFailure,
  autopilotTickArgs,
  diffWorkspaceSnapshots,
  verifyOutcome,
  pulseWorkspaceKey,
  pulseWorkspaceMarker,
  crontabLineBelongsToWorkspace,
  buildPulseScorecardRow,
  buildInterruptedPulseReceipt,
  scoreTick,
  normalizeExpiryDuration,
  shouldWriteScorecard,
  shouldFallbackToAutopilot,
  findOrphanStarts,
  detectStaleTick,
  summarizePulse,
  appendJsonl,
  readJsonl,
  readPulseReceipts,
  appendPulseReceipt,
  appendScorecard,
  nextTickIndex,
  acquireLock,
  releaseLock,
  buildTickScript,
  buildCrontabLine,
  normalizeCronCadence,
};
