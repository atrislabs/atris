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
    changed_files: Array.isArray(input.changedFiles) ? input.changedFiles : [],
    what: input.what || null,
    elapsed_ms: input.elapsedMs != null ? input.elapsedMs : null,
    prev_tick_stale: input.prevTickStale != null ? input.prevTickStale : false,
    reward: input.reward != null ? input.reward : null,
  };
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

// The heartbeat's full composition (mirrors the /loop skill): run the due
// mission to continue an existing goal; if none is due, fall back to an
// autopilot tick — that path is where proposeCandidateHorizons AUTHORS a new
// goal at an endgame boundary. The fallback needs a worker, so skip it under
// --no-runner (or the legacy --no-claude alias).
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
    model = 'opus',
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

# Autonomous ticks must target a live model alias, never a versioned id that can
# retire out from under the loop (lesson: retired-model-kills-loop-silently).
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
  return `${cron} ${scriptPath} # ${marker}`;
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
  buildPulseScorecardRow,
  scoreTick,
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
};
