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
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const { DEFAULT_CLAUDE_RUNNER_MODEL } = require('./runner-command');

const PULSE_RECEIPT_SCHEMA = 'atris.pulse_tick.v1';
// Reuse the improve-tick scorecard schema so the brain + policy-lessons see
// pulse reward as fresh feedback signal (source:'pulse' keeps it attributable).
const SCORECARD_SCHEMA = 'atris.improve_tick.v1';
const PULSE_MARKER = 'ATRIS_PULSE_SELF_IMPROVE';
const LEGACY_STATE_DIRNAME = 'atris-cli-self-improve';
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

// --- install slot identity ---

function safeSlugPart(value) {
  const cleaned = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned || 'repo';
}

function pulseRepoSlug(root) {
  const absoluteRoot = path.resolve(root || process.cwd());
  const base = safeSlugPart(path.basename(absoluteRoot));
  const hash = crypto.createHash('sha256').update(absoluteRoot).digest('hex').slice(0, 6);
  return `${base}-${hash}`;
}

function pulseStateHome(root, homeDir = os.homedir()) {
  return path.join(homeDir, '.atris', 'overnight', `pulse-${pulseRepoSlug(root)}`);
}

function pulseMarker(root) {
  return `ATRIS_PULSE_${pulseRepoSlug(root).toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
}

function legacyPulseStateHome(homeDir = os.homedir()) {
  return path.join(homeDir, '.atris', 'overnight', LEGACY_STATE_DIRNAME);
}

function readTickScriptRoot(stateHome) {
  try {
    const script = fs.readFileSync(path.join(stateHome, 'tick.sh'), 'utf8');
    const match = script.match(/^ROOT=(?:"([^"\n]*)"|'([^'\n]*)'|([^\s\n]+))/m);
    if (!match) return null;
    return match[1] || match[2] || match[3] || null;
  } catch {
    return null;
  }
}

function legacyPulseStateMatchesRoot(root, homeDir = os.homedir()) {
  const legacyStateHome = legacyPulseStateHome(homeDir);
  const scriptRoot = readTickScriptRoot(legacyStateHome);
  if (!scriptRoot) return false;
  return path.resolve(scriptRoot) === path.resolve(root || process.cwd());
}

function resolvePulseSlot(root, options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const stateHome = pulseStateHome(root, homeDir);
  const marker = pulseMarker(root);
  const legacyStateHome = legacyPulseStateHome(homeDir);
  const legacyMatches = legacyPulseStateMatchesRoot(root, homeDir);
  const hasStateHome = fs.existsSync(stateHome);
  const activeStateHome = legacyMatches && !hasStateHome ? legacyStateHome : stateHome;
  const activeMarker = legacyMatches && !hasStateHome ? PULSE_MARKER : marker;
  const markers = legacyMatches ? [marker, PULSE_MARKER] : [marker];
  return {
    slug: pulseRepoSlug(root),
    stateHome,
    marker,
    activeStateHome,
    activeMarker,
    legacyStateHome,
    legacyMarker: PULSE_MARKER,
    legacyMatches,
    markers,
  };
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

// --- non-git work detection ---
//
// A workspace without .git made producedWork permanently false (git snapshots
// return an empty delta), so every tick scored 0 regardless of what the engine
// wrote — the loop was blind, not idle. When git is absent, pulse falls back to
// a filesystem snapshot: path → mtime+size, excluding churn dirs.

const FS_SNAPSHOT_SKIP = new Set(['.git', 'node_modules', '.atris']);
const FS_SNAPSHOT_MAX_ENTRIES = 20000;

function fsSnapshot(root) {
  const entries = new Map();
  const walk = (dir, rel) => {
    if (entries.size >= FS_SNAPSHOT_MAX_ENTRIES) return;
    let names;
    try {
      names = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of names) {
      if (entries.size >= FS_SNAPSHOT_MAX_ENTRIES) return;
      if (FS_SNAPSHOT_SKIP.has(d.name)) continue;
      const abs = path.join(dir, d.name);
      const r = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) walk(abs, r);
      else if (d.isFile()) {
        try {
          const st = fs.statSync(abs);
          entries.set(r, `${st.mtimeMs}:${st.size}`);
        } catch {}
      }
    }
  };
  walk(root, '');
  return entries;
}

// New or modified files between two fsSnapshots. Deletions are ignored — the
// signal we need is "did the tick author anything", not a full diff.
function diffFsSnapshots(before, after) {
  const changed = [];
  for (const [rel, sig] of after) {
    if (before.get(rel) !== sig) changed.push(rel);
  }
  return changed.sort();
}

// The verify default must match the workspace. Defaulting to `npm test` in a
// root with no package.json guaranteed -1 on any productive tick.
function defaultVerifyCmd(root) {
  return fs.existsSync(path.join(root, 'package.json')) ? 'npm test' : null;
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
  // A null verifyCmd (e.g. non-npm workspace) omits --verify so the tick
  // resolves the workspace-appropriate default at run time.
  const safeVerify = verifyCmd == null ? null : String(verifyCmd).replace(/'/g, "'\\''");
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

"$ATRIS" pulse tick --json${safeVerify == null ? '' : ` --verify '${safeVerify}'`} >> "$log" 2>&1
tick_status=$?

# runDaily no-ops via last_run_date after the first daily run.
# hourly invocation is safe because repeated calls do no work.
"$ATRIS" experiments daily >> "$log" 2>&1 || true
echo "done: $(date -Iseconds) exit=$tick_status" >> "$log"

# Ticks commit locally but nothing reaches the remote without this: push any
# commits the loop has landed since the last successful push.
if [ -e "$ROOT/.git" ]; then
  branch="$(git -C "$ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null)"
  if [ -n "$branch" ] && [ "$branch" != "HEAD" ]; then
    ahead="$(git -C "$ROOT" rev-list --count "origin/$branch..$branch" 2>/dev/null || echo 0)"
    if [ "$ahead" -gt 0 ]; then
      git -C "$ROOT" push origin "$branch" >> "$log" 2>&1
      echo "pushed $ahead commit(s) to origin/$branch: $(date -Iseconds)" >> "$log"
    fi
  fi
fi
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
  LEGACY_STATE_DIRNAME,
  DEFAULT_CADENCE_CRON,
  STALE_TICK_MS,
  LIVENESS_STALE_MS,
  stateDir,
  pulseRepoSlug,
  pulseStateHome,
  pulseMarker,
  legacyPulseStateHome,
  readTickScriptRoot,
  legacyPulseStateMatchesRoot,
  resolvePulseSlot,
  pulseReceiptsPath,
  scorecardsPath,
  pulseCounterPath,
  pulseLockDir,
  buildPulseReceipt,
  buildPulseScorecardRow,
  buildInterruptedPulseReceipt,
  scoreTick,
  fsSnapshot,
  diffFsSnapshots,
  defaultVerifyCmd,
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
