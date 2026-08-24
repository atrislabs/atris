'use strict';

/**
 * atris improve — run one paid RL improvement tick on the workspace.
 *
 * Calls POST /api/improve on the backend, which plans one task, builds it,
 * runs the verify command, scores it, and deducts Atris credits per
 * successful tick. Returns what shipped + reward and writes a per-tick
 * scorecard row to .atris/state/scorecards.jsonl (the receipt the brain
 * ledger already counts).
 *
 * This is the CLI entrypoint for the headline paid capability. The member
 * loop and the /improve skill both call it. If the backend is unreachable
 * or the user is not logged in, it falls back to one local mission tick
 * (same loop, local inference) instead of erroring silently.
 *
 * The orchestrator (runImprove) takes injected deps so the network, auth,
 * fallback, and scorecard writes can all be faked in tests.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { apiRequestJson, getApiBaseUrl } = require('../utils/api');
const { loadCredentials } = require('../utils/auth');
const pulse = require('../lib/pulse');
const { cronInstalled } = require('./pulse');
const close = require('./close');
const { readUsage } = require('../lib/usage');
const { knownCommands } = require('../lib/known-commands');

/**
 * Expand a leading `~` to the real home directory for LOCAL filesystem
 * writes. The path sent to the backend is left untouched — a remote tick
 * may target a server-side `~/...` workspace the server expands itself — but
 * local scorecard/journal writes must never create a literal `~` directory.
 * (Surfaced by a live plan tick whose `~/arena/...` arg wrote junk locally.)
 */
function expandHome(p) {
  if (typeof p === 'string' && (p === '~' || p.startsWith('~/'))) {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

const SCORECARD_SCHEMA = 'atris.improve_tick.v1';
const IMPROVE_VITALS_SCHEMA = 'atris.improve_vitals.v1';
const DEFAULT_TIMEOUT_MS = 300000;
const VALID_MODES = new Set(['full', 'plan', 'delegate']);
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Resolve the improve endpoint path relative to the configured API base.
 * The backend mounts the router at /api/improve. The CLI's default base
 * (https://api.atris.ai/api) already includes /api, so we append /improve;
 * a bare base (e.g. http://localhost:8000) needs the full /api/improve.
 */
function improveApiPath(baseUrl) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  return base.endsWith('/api') ? '/improve' : '/api/improve';
}

function hostedApiCannotReachLocalWorkspace(workspace, baseUrl) {
  if (!path.isAbsolute(String(workspace || ''))) return false;
  try {
    if (!fs.statSync(workspace).isDirectory()) return false;
    const hostname = new URL(baseUrl).hostname.replace(/^\[|\]$/g, '').toLowerCase();
    const loopback = hostname === 'localhost'
      || hostname.endsWith('.localhost')
      || hostname === '::1'
      || hostname === '0.0.0.0'
      || hostname.startsWith('127.');
    return !loopback;
  } catch {
    return false;
  }
}

function parseImproveArgs(argv = []) {
  const args = Array.isArray(argv) ? [...argv] : [];
  const opts = {
    mode: 'full',
    model: null,
    member: null,
    dryRun: false,
    json: false,
    fallback: true,
    workspace: process.cwd(),
    timeoutMs: DEFAULT_TIMEOUT_MS,
    help: false,
    history: false,
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--help' || a === '-h') { opts.help = true; continue; }
    if (a === 'history' || a === '--history') { opts.history = true; continue; }
    if (a === '--json') { opts.json = true; continue; }
    if (a === '--no-fallback') { opts.fallback = false; continue; }
    if (a === '--dry-run' || a === 'dry-run' || a === 'dry_run') { opts.dryRun = true; continue; }
    if (a === '--mode') { const v = args[++i]; if (v) opts.mode = v; continue; }
    if (a === '--model') { const v = args[++i]; if (v) opts.model = v; continue; }
    if (a === '--member') { const v = args[++i]; if (v) opts.member = v; continue; }
    if (a === '--workspace') { const v = args[++i]; if (v) opts.workspace = v; continue; }
    if (a === '--timeout') { const v = Number(args[++i]); if (v > 0) opts.timeoutMs = Math.round(v * 1000); continue; }
    if (a.startsWith('--timeout=')) { const v = Number(a.split('=')[1]); if (v > 0) opts.timeoutMs = Math.round(v * 1000); continue; }
    // positional mode (plan|full|delegate)
    if (!a.startsWith('-') && VALID_MODES.has(a)) { opts.mode = a; continue; }
  }

  if (!VALID_MODES.has(opts.mode)) opts.mode = 'full';
  return opts;
}

function buildImprovePayload(opts = {}) {
  const body = {
    workspace: opts.workspace || process.cwd(),
    mode: opts.mode || 'full',
  };
  if (opts.model) body.model = opts.model;
  if (opts.dryRun) body.dry_run = true;
  if (opts.businessId) body.business_id = opts.businessId;
  return body;
}

/**
 * Normalize the /api/improve response into a stable summary, reading every
 * field defensively. The full-mode ImproveResponse omits credits_deducted
 * (credits are still billed server-side), so credits may be null even on a
 * successful, charged tick — callers must not assume it is present.
 */
function summarizeImproveResponse(data = {}) {
  const d = data && typeof data === 'object' ? data : {};
  const verify = d.verify_passed != null ? d.verify_passed
    : (d.verify_pass != null ? d.verify_pass : null);
  const credits = d.credits_deducted != null ? d.credits_deducted
    : (d.credits_charged != null ? d.credits_charged : null);
  const files = Array.isArray(d.files_written) ? d.files_written
    : Array.isArray(d.files_changed) ? d.files_changed
      : Array.isArray(d.files) ? d.files : [];
  const reward = typeof d.reward === 'number' ? d.reward
    : (d.reward != null && !Number.isNaN(Number(d.reward)) ? Number(d.reward) : null);
  return {
    shipped: d.what_shipped || d.summary || d.task_description || d.task || null,
    reward,
    verify,
    credits,
    files,
    model: d.model_used || d.model || null,
    taskId: d.task_id || d.taskId || null,
    // The backend returns both of these; a failing tick is unteachable without
    // them — "verify_passed: false" says nothing about WHICH task or WHY.
    taskDescription: d.task_description || d.task_title || null,
    verifyOutput: typeof d.verify_output === 'string' ? d.verify_output : null,
    elapsedMs: typeof d.elapsed_ms === 'number' ? d.elapsed_ms : null,
    scorecardWritten: d.scorecard_written === true,
    error: d.error || null,
  };
}

/**
 * Decide whether to fall back to one local mission tick. Fallback only when
 * the backend is genuinely unavailable: no auth, or unreachable (status 0).
 * A real HTTP error (insufficient credits 402, server error 5xx) is reported
 * honestly — we never silently run local work and bill nothing on what was a
 * real, answerable failure.
 */
function shouldFallbackLocal({ creds, apiResult } = {}) {
  if (!creds || !creds.token) return { fallback: true, reason: 'no_auth' };
  if (!apiResult) return { fallback: false, reason: 'no_result' };
  if (apiResult.ok) return { fallback: false, reason: 'api_ok' };
  if (apiResult.status === 0) return { fallback: true, reason: 'unreachable' };
  // The hosted backend validates workspace_path against its own filesystem,
  // so a local-only folder 403s even for an authed, funded user. That is an
  // unreachable-workspace condition — run the same tick locally instead of
  // dying on it. Other 403s (real permission failures) are still reported.
  if (apiResult.status === 403 && isWorkspaceNotAllowedError(apiResult)) {
    return { fallback: true, reason: 'workspace_not_on_backend' };
  }
  return { fallback: false, reason: `api_error_${apiResult.status}` };
}

const WORKSPACE_NOT_ALLOWED_TEXT = 'workspace_path must be under an allowed directory';

function isWorkspaceNotAllowedError(apiResult = {}) {
  const candidates = [
    apiResult.error,
    apiResult.error && apiResult.error.error,
    apiResult.data && apiResult.data.detail,
    apiResult.data && apiResult.data.detail && apiResult.data.detail.error,
  ];
  return candidates.some((c) => typeof c === 'string' && c.includes(WORKSPACE_NOT_ALLOWED_TEXT));
}

/** Keep the failure tail bounded: the last lines are where the reason is. */
const VERIFY_OUTPUT_TAIL_CHARS = 2000;

function verifyOutputTail(output) {
  if (typeof output !== 'string') return null;
  const text = output.trim();
  if (!text) return null;
  return text.length > VERIFY_OUTPUT_TAIL_CHARS ? text.slice(-VERIFY_OUTPUT_TAIL_CHARS) : text;
}

function buildScorecardRow(summary = {}, meta = {}) {
  // Only failures carry the verify tail. A passing tick does not need it, and
  // 2KB per row would bloat a ledger that is already ~2000 rows.
  const failed = summary.verify === false;
  return {
    schema: SCORECARD_SCHEMA,
    ts: meta.ts || new Date().toISOString(),
    source: meta.source || 'api',
    member: meta.member || null,
    mode: meta.mode || 'full',
    reward: summary.reward != null ? summary.reward : null,
    verify_passed: summary.verify != null ? summary.verify : null,
    credits_deducted: summary.credits != null ? summary.credits : null,
    what_shipped: summary.shipped || null,
    files_written: Array.isArray(summary.files) ? summary.files : [],
    model_used: summary.model || null,
    task_id: summary.taskId || null,
    task_description: summary.taskDescription || null,
    verify_output: failed ? verifyOutputTail(summary.verifyOutput) : null,
    elapsed_ms: summary.elapsedMs != null ? summary.elapsedMs : null,
  };
}

function appendScorecardRow(workspace, row) {
  const dir = path.join(expandHome(workspace), '.atris', 'state');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'scorecards.jsonl');
  fs.appendFileSync(file, `${JSON.stringify(row)}\n`, 'utf8');
  return file;
}

/**
 * Read the improve-tick scorecard rows the loop writes. This is the
 * substrate that makes the loop recursive: each tick appends a receipt,
 * and the next tick (or a human) reads the accumulated rows to see whether
 * the loop is actually compounding.
 */
function readTickHistory(workspace) {
  const file = path.join(expandHome(workspace), '.atris', 'state', 'scorecards.jsonl');
  if (!fs.existsSync(file)) return [];
  const rows = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const row = JSON.parse(trimmed);
      if (row && row.schema === SCORECARD_SCHEMA) rows.push(row);
    } catch {
      // skip non-JSON / foreign rows
    }
  }
  return rows;
}

/**
 * Summarize the tick history into the compounding signal: how many ticks
 * shipped, the reward trend, total credits spent, and the verify pass rate.
 * This is the answer to "is the self-improvement loop getting better?".
 */
function summarizeTickHistory(rows = []) {
  const ticks = Array.isArray(rows) ? rows : [];
  const verified = ticks.filter((r) => r.verify_passed === true);
  const rewards = ticks.map((r) => (typeof r.reward === 'number' ? r.reward : 0));
  const totalReward = rewards.reduce((a, b) => a + b, 0);
  const totalCredits = ticks.reduce((a, r) => a + (typeof r.credits_deducted === 'number' ? r.credits_deducted : 0), 0);
  const rewardTrend = ticks.map((r) => (typeof r.reward === 'number' ? r.reward : null));
  return {
    ticks: ticks.length,
    shipped: verified.length,
    passRate: ticks.length ? verified.length / ticks.length : 0,
    totalReward,
    avgReward: ticks.length ? totalReward / ticks.length : 0,
    totalCredits,
    rewardTrend,
    first: ticks[0] || null,
    latest: ticks[ticks.length - 1] || null,
  };
}

function formatTickHistory(summary = {}) {
  const lines = [];
  lines.push('improve loop — tick history');
  lines.push('');
  lines.push(`  ticks:    ${summary.ticks}`);
  lines.push(`  shipped:  ${summary.shipped}/${summary.ticks} (verify pass ${Math.round((summary.passRate || 0) * 100)}%)`);
  lines.push(`  reward:   total ${summary.totalReward}, avg ${(summary.avgReward || 0).toFixed(1)}`);
  lines.push(`  credits:  ${summary.totalCredits} deducted`);
  if (summary.rewardTrend && summary.rewardTrend.length) {
    lines.push(`  trend:    ${summary.rewardTrend.map((r) => (r == null ? '·' : r)).join(' → ')}`);
  }
  if (!summary.ticks) lines.push('  (no ticks yet — run `atris improve`)');
  return lines.join('\n');
}

// Local calendar day — journal receipts are local workspace files, never UTC
// (see lessons.md: now-front-door-uses-local-date).
function localDateKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function localHourMinute(d = new Date()) {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function readJsonFile(file, fallback = null) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function readJsonlFile(file) {
  try {
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function timestampMs(value) {
  const ms = Date.parse(String(value || ''));
  return Number.isFinite(ms) ? ms : null;
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

// Spell small counts as words so the vitals read as prose; digits above nine.
const SMALL_NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];

function countWord(n) {
  return n >= 0 && n < SMALL_NUMBER_WORDS.length ? SMALL_NUMBER_WORDS[n] : String(n);
}

function formatReward(value) {
  const n = Number(value) || 0;
  if (Number.isInteger(n)) return String(n);
  return String(Number(n.toFixed(2)));
}

function agePhrase(ts, nowMs = Date.now()) {
  const ms = timestampMs(ts);
  if (ms == null) return null;
  const delta = Math.max(0, nowMs - ms);
  if (delta < 60 * 1000) return 'just now';
  if (delta < 60 * 60 * 1000) return `${plural(Math.round(delta / (60 * 1000)), 'minute')} ago`;
  if (delta < DAY_MS) return `${plural(Math.round(delta / (60 * 60 * 1000)), 'hour')} ago`;
  if (delta < 30 * DAY_MS) return `${plural(Math.round(delta / DAY_MS), 'day')} ago`;
  return `on ${new Date(ms).toISOString().slice(0, 10)}`;
}

function plainSentence(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function latestByTime(rows, fields) {
  let latest = null;
  let latestMs = -Infinity;
  for (const row of Array.isArray(rows) ? rows : []) {
    for (const field of fields) {
      const ms = timestampMs(row && row[field]);
      if (ms != null && ms > latestMs) {
        latest = row;
        latestMs = ms;
      }
    }
  }
  return latest ? { row: latest, ms: latestMs } : null;
}

function scoutFindingLanded(row = {}) {
  if (!row || typeof row !== 'object') return false;
  if (row.finding_landed === true || row.finding === true) return true;
  if (Array.isArray(row.findings) && row.findings.length > 0) return true;
  if (row.result && typeof row.result === 'object') {
    if (row.result.finding_landed === true || row.result.finding === true) return true;
    if (Array.isArray(row.result.findings) && row.result.findings.length > 0) return true;
  }
  const landing = row.last_landing || (row.result && row.result.landing) || row.landing;
  if (landing && typeof landing === 'object') {
    const text = `${landing.finding || ''} ${landing.findings || ''}`.trim();
    if (text) return true;
  }
  return false;
}

function collectImproveVitals(options = {}, deps = {}) {
  const root = expandHome(options.workspace || process.cwd());
  const nowDate = options.now ? new Date(options.now) : new Date();
  const nowMs = Number.isFinite(nowDate.getTime()) ? nowDate.getTime() : Date.now();
  const today = localDateKey(new Date(nowMs));

  const readPulse = deps.readPulseReceipts || pulse.readPulseReceipts;
  const pulsePath = (deps.pulseReceiptsPath || pulse.pulseReceiptsPath)(root);
  const receipts = readPulse(root);
  const finished = (Array.isArray(receipts) ? receipts : []).filter((row) => row && row.phase === 'finished');
  const latestPulse = latestByTime(finished, ['ts']);
  const rewardSince = nowMs - DAY_MS;
  const rewardToday = finished.reduce((sum, row) => {
    const ms = timestampMs(row.ts);
    return ms != null && ms >= rewardSince ? sum + (Number(row.reward) || 0) : sum;
  }, 0);
  const heartbeatAge = latestPulse ? agePhrase(latestPulse.row.ts, nowMs) : null;
  const heartbeatSentence = latestPulse
    ? `the scheduled improve heartbeat last beat ${heartbeatAge} and earned ${formatReward(rewardToday)} reward today.`
    : `the scheduled improve heartbeat has not beaten yet and earned ${formatReward(rewardToday)} reward today.`;
  const cronFn = deps.cronInstalled || cronInstalled;
  // Per-repo slots (pr 310): the crontab marker is derived from the root, so
  // the check must ask about THIS repo's markers, not the legacy default.
  const slot = (() => {
    try { return pulse.resolvePulseSlot(root); } catch { return null; }
  })();
  const slotMarkers = slot ? slot.markers : undefined;
  const legacyCronInstalled = Boolean(slotMarkers ? cronFn(slotMarkers) : cronFn());
  const homeDir = deps.homeDir || os.homedir();
  const launchdInstalled = (() => {
    if (!slot) return false;
    const label = `com.atris.pulse.${slot.marker.toLowerCase().replace(/^atris_pulse_/, '').replace(/[^a-z0-9]+/g, '-')}`;
    const plistPath = path.join(homeDir, 'Library', 'LaunchAgents', `${label}.plist`);
    return fs.existsSync(plistPath);
  })();
  const installed = launchdInstalled || legacyCronInstalled;
  const installNudge = installed ? null : 'the scheduled improve loop is off. turn it on: atris pulse install --model claude-sonnet-5';

  const experimentsPath = path.join(root, '.atris', 'state', 'experiments-daily.json');
  const experiments = readJsonFile(experimentsPath, {});
  const history = Array.isArray(experiments && experiments.history) ? experiments.history : [];
  const experimentRanToday = String(experiments && experiments.last_run_date || '') === today;
  const exploitSentence = `${experimentRanToday ? 'todays experiment already ran' : 'no experiment yet today'}, with ${plural(history.length, 'total experiment')}.`;

  const missionsPath = path.join(root, '.atris', 'state', 'missions.jsonl');
  const missions = readJsonlFile(missionsPath);
  const scoutMissions = missions.filter((row) => {
    const owner = String(row && row.owner || '').toLowerCase();
    return owner === 'scout' || owner === 'signal-scout' || owner.endsWith('-scout');
  });
  const latestScout = latestByTime(scoutMissions, [
    'last_tick_at',
    'last_tick_finished_at',
    'finished_at',
    'updated_at',
    'created_at',
    'started_at',
  ]);
  const scoutAge = latestScout ? agePhrase(new Date(latestScout.ms).toISOString(), nowMs) : null;
  const findingLanded = latestScout ? scoutFindingLanded(latestScout.row) : false;
  const exploreSentence = latestScout
    ? `the scout last explored ${scoutAge} and ${findingLanded ? 'landed a finding' : 'no finding landed'}.`
    : 'the scout has not explored yet and no finding landed.';

  const openFlags = (deps.openFlags || close.openFlags)(root, { now: new Date(nowMs) });
  const sweep = (deps.sweepState || close.sweepState)(root, new Date(nowMs), { dryRun: true });
  const overdue = Array.isArray(sweep.overdue) ? sweep.overdue : openFlags.filter((flag) => flag && flag.overdue);
  const topOverdueSentence = overdue[0] ? plainSentence((deps.sweepLine || close.sweepLine)(overdue[0])) : null;
  const excreteSentence = `the excretion loop has ${plural(openFlags.length, 'open loop')} and ${plural(overdue.length, 'overdue loop')}.`;

  const usageRows = (deps.readUsage || readUsage)(root, { sinceDays: 7, now: new Date(nowMs).toISOString() });
  const known = deps.knownCommands || knownCommands;
  const knownSet = new Set(known);
  const usedThisWeek = new Set((Array.isArray(usageRows) ? usageRows : [])
    .map((row) => row && row.cmd)
    .filter((cmd) => knownSet.has(cmd)));
  const usageSentence = `you used ${usedThisWeek.size} of ${known.length} known commands this week.`;

  const heartbeat = {
    receipts_path_exists: fs.existsSync(pulsePath),
    last_finished_at: latestPulse ? latestPulse.row.ts : null,
    last_finished_ago: heartbeatAge,
    reward_last_24h: Number(formatReward(rewardToday)),
    cron_installed: installed,
    sentence: plainSentence(heartbeatSentence),
  };
  const exploit = {
    ran_today: experimentRanToday,
    total_experiments: history.length,
    last_run_date: experiments && experiments.last_run_date || null,
    sentence: plainSentence(exploitSentence),
  };
  const explore = {
    total_scout_missions: scoutMissions.length,
    last_tick_at: latestScout ? new Date(latestScout.ms).toISOString() : null,
    last_tick_ago: scoutAge,
    finding_landed: findingLanded,
    sentence: plainSentence(exploreSentence),
  };
  const excrete = {
    open: openFlags.length,
    overdue: overdue.length,
    top_overdue_sentence: topOverdueSentence,
    sentence: plainSentence(excreteSentence),
  };
  const usage = {
    used_this_week: usedThisWeek.size,
    known_commands: known.length,
    sentence: plainSentence(usageSentence),
  };

  // The guarantee gauge: agent landings vs human fixes over the last 14 days.
  // Collection is bounded by --since so a huge repo only walks a fortnight.
  // No git history (not a repo, git missing) means the line is omitted silently.
  let guarantee = null;
  try {
    const collect = deps.collectRevisionSignals || collectRevisionSignals;
    const rev = collect(root, { days: 14, now: nowMs });
    const landingsPhrase = `${countWord(rev.landings)} landing${rev.landings === 1 ? '' : 's'} this fortnight`;
    const fixPhrase = `${countWord(rev.revised)} needed a human fix`;
    guarantee = {
      days: rev.days,
      landings: rev.landings,
      revised: rev.revised,
      rate: rev.rate,
      sentence: plainSentence(`${landingsPhrase}, ${fixPhrase}.`),
    };
  } catch {
    guarantee = null;
  }

  const sentences = [
    heartbeat.sentence,
    exploit.sentence,
    explore.sentence,
    excrete.sentence,
    ...(topOverdueSentence ? [`the top overdue loop says ${topOverdueSentence}`] : []),
    usage.sentence,
    ...(guarantee ? [guarantee.sentence] : []),
  ];
  const groups = [
    [heartbeat.sentence, installNudge].filter(Boolean),
    [exploit.sentence],
    [explore.sentence],
    [excrete.sentence, ...(topOverdueSentence ? [`the top overdue loop says ${topOverdueSentence}`] : [])],
    [usage.sentence],
    ...(guarantee ? [[guarantee.sentence]] : []),
  ];

  return {
    schema: IMPROVE_VITALS_SCHEMA,
    generated_at: new Date(nowMs).toISOString(),
    heartbeat,
    exploit,
    explore,
    excrete,
    usage,
    guarantee,
    install_nudge: installNudge,
    sentences,
    groups,
  };
}

function formatImproveVitals(vitals = {}) {
  const groups = Array.isArray(vitals.groups) ? vitals.groups : [];
  return groups
    .map((group) => group.filter(Boolean).map(plainSentence).join('\n'))
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Append a human-readable tick entry to today's journal under ## Notes.
 * The skill contract says every tick lands in the journal; the JSONL
 * scorecard is the machine receipt, this is the operator-readable trail.
 */
function appendTickToJournal(workspace, summary = {}, opts = {}) {
  const dateKey = opts.dateKey || localDateKey();
  const time = opts.time || localHourMinute();
  const year = dateKey.slice(0, 4);
  const logFile = path.join(expandHome(workspace), 'atris', 'logs', year, `${dateKey}.md`);
  fs.mkdirSync(path.dirname(logFile), { recursive: true });

  const source = opts.source || 'api';
  const verify = summary.verify === true ? 'pass' : summary.verify === false ? 'fail' : 'unknown';
  const credits = summary.credits != null ? summary.credits : 'server-side';
  const owner = opts.member ? ` · member: ${opts.member}` : '';
  const block = [
    `### Improve Tick — ${time}`,
    `- shipped: ${summary.shipped || '(no description)'}`,
    `- verify: ${verify} · reward: ${summary.reward != null ? summary.reward : '?'} · credits: ${credits} · source: ${source}${owner}`,
    '',
  ].join('\n');

  let content = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : `# ${dateKey}\n\n## Notes\n`;
  if (content.includes('## Notes')) {
    content = content.replace('## Notes\n', `## Notes\n\n${block}`);
  } else {
    content = `${content.replace(/\n*$/, '')}\n\n## Notes\n\n${block}`;
  }
  fs.writeFileSync(logFile, content, 'utf8');
  return logFile;
}

function resolveAtrisBin() {
  const local = path.join(__dirname, '..', 'bin', 'atris.js');
  if (fs.existsSync(local)) return local;
  return process.env.ATRIS_BIN || 'atris';
}

// The improve contract is one call -> one tick. Use the mission runtime
// directly so the tick count and verifier result come back as structured JSON
// instead of hiding several mission ticks inside one autopilot leg.
const LOCAL_FALLBACK_ARGS = ['mission', 'run', '--due', '--headless', '--max-ticks', '1', '--complete-on-pass', '--json'];

function localFallbackArgs(budgetSec) {
  return LOCAL_FALLBACK_ARGS.concat(['--max-wall', String(Math.max(60, Math.round(budgetSec)))]);
}

function localSummaryText(tick = {}, mission = {}) {
  const candidates = [
    tick.claude && tick.claude.summary,
    tick.atris2 && tick.atris2.summary,
    tick.drill && tick.drill.summary,
    mission.objective,
  ];
  return String(candidates.find((value) => String(value || '').trim()) || 'verified local improvement')
    .replace(/\s+/g, ' ')
    .trim();
}

function tickTouchedFiles(worktree = {}) {
  if (!Array.isArray(worktree.new_dirty_sample)) return [];
  return worktree.new_dirty_sample.map((entry) => {
    const pathText = String(entry || '').slice(3);
    const arrow = pathText.indexOf(' -> ');
    return arrow >= 0 ? pathText.slice(arrow + 4) : pathText;
  }).filter(Boolean);
}

/**
 * Turn one mission-run JSON result into the same stable summary the paid API
 * returns. A local tick earns the conservative local reward (+1) only after
 * its real verifier passes; missing proof is a failed improve call.
 */
function summarizeLocalMissionRun(payload = {}) {
  const ticks = Array.isArray(payload.ticks) ? payload.ticks : [];
  const tickCount = Number(payload.tick_count != null ? payload.tick_count : ticks.length);
  if (!payload.ok || payload.action !== 'mission_run') {
    throw new Error(`local improve did not run a mission tick${payload.reason ? `: ${payload.reason}` : ''}`);
  }
  if (tickCount !== 1 || ticks.length !== 1) {
    throw new Error(`local improve must run exactly one tick; got ${tickCount}`);
  }
  const tick = ticks[0] || {};
  if (tick.status !== 'ran') {
    throw new Error(`local improve tick did not run${tick.reason ? `: ${tick.reason}` : ''}`);
  }
  if (tick.claude?.skipped === true || ['caller-session-runner', 'no-claude-mode'].includes(tick.reason)) {
    throw new Error('local improve worker did not run');
  }
  if (tick.verifier_passed !== true) {
    throw new Error('local improve verifier did not pass');
  }
  const mission = payload.mission || {};
  const files = tickTouchedFiles(tick.worktree);
  return {
    shipped: localSummaryText(tick, mission),
    reward: 1,
    verify: true,
    credits: 0,
    files,
    model: mission.model || mission.runner || null,
    taskId: mission.task_id || mission.current_task_id || null,
    elapsedMs: null,
    scorecardWritten: false,
  };
}

function runLocalFallback(opts = {}) {
  const bin = resolveAtrisBin();
  const isScript = bin.endsWith('.js');
  const cmd = isScript ? process.execPath : bin;
  // Tell autopilot its time budget so it lands gracefully ("budget spent")
  // instead of being SIGKILLed mid-leg and reporting a failed tick. The spawn
  // timeout stays as a backstop, one minute past the budget.
  const budgetSec = Math.max(60, Number(opts.timeoutSec) || 600);
  const argv = (isScript ? [bin] : []).concat(localFallbackArgs(budgetSec));
  const r = spawnSync(cmd, argv, {
    cwd: opts.workspace || process.cwd(),
    encoding: 'utf8',
    env: process.env,
    // Mission output is JSON even for the human-facing improve command because
    // proof must be parsed before improve can claim success or write a receipt.
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: (budgetSec + 60) * 1000,
  });
  let payload = null;
  let summary = null;
  let error = null;
  if (r.status === 0) {
    try {
      payload = JSON.parse(String(r.stdout || '').trim());
      summary = summarizeLocalMissionRun(payload);
    } catch (e) {
      error = e.message;
    }
  } else {
    error = String(r.stderr || '').trim().split('\n').filter(Boolean).slice(-1)[0]
      || `local improve exited ${r.status == null ? 1 : r.status}`;
  }
  return {
    ok: r.status === 0 && Boolean(summary),
    status: r.status == null ? 1 : r.status,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    payload,
    summary,
    error,
  };
}

/**
 * Run one improvement tick. Dependency-injected so tests can fake the
 * network (apiRequestJson), auth (loadCredentials), the local fallback,
 * and the scorecard sink.
 *
 * Returns a structured result:
 *   { ok, source: 'api'|'local'|'none', reason, summary?, scorecardPath?, local?, apiResult?, error? }
 */
async function runImprove(opts = {}, deps = {}) {
  const apiFn = deps.apiRequestJson || apiRequestJson;
  const loadCreds = deps.loadCredentials || loadCredentials;
  const localFn = deps.runLocalFallback || runLocalFallback;
  const writeRow = deps.appendScorecardRow || appendScorecardRow;
  const writeJournal = deps.appendTickToJournal || appendTickToJournal;
  const baseFn = deps.getApiBaseUrl || getApiBaseUrl;
  const now = deps.now || (() => new Date().toISOString());
  const log = deps.log || (() => {});

  const workspace = opts.workspace || process.cwd();
  const timeoutSec = Math.round((opts.timeoutMs || DEFAULT_TIMEOUT_MS) / 1000);
  const startedAt = now();
  const creds = loadCreds();
  const shippingTick = (opts.mode || 'full') === 'full' && !opts.dryRun;
  const localFallbackEligible = opts.fallback && shippingTick;

  const finishLocalFallback = (reason, apiResult = null) => {
    const local = localFn({ workspace, json: opts.json, timeoutSec });
    const finishedAt = now();
    if (!local.ok || !local.summary || local.summary.verify !== true) {
      return {
        ok: false,
        source: 'local',
        reason,
        error: local.error || 'local improve verifier did not pass',
        local,
        ...(apiResult ? { apiResult } : {}),
        startedAt,
        finishedAt,
      };
    }
    const row = buildScorecardRow(local.summary, {
      source: 'local',
      mode: opts.mode || 'full',
      ts: finishedAt,
      member: opts.member,
    });
    let scorecardPath;
    let journalPath;
    try {
      scorecardPath = writeRow(workspace, row);
      journalPath = writeJournal(workspace, local.summary, { source: 'local', member: opts.member });
    } catch (e) {
      return {
        ok: false,
        source: 'local',
        reason,
        error: `local improve receipt write failed: ${e.message}`,
        local,
        ...(apiResult ? { apiResult } : {}),
        startedAt,
        finishedAt,
      };
    }
    return {
      ok: true,
      source: 'local',
      reason,
      summary: local.summary,
      scorecardPath,
      journalPath,
      receipt: 'written',
      row,
      local,
      ...(apiResult ? { apiResult } : {}),
      startedAt,
      finishedAt,
    };
  };

  // Dry-run is a local plan only. Never call the paid /api/improve endpoint.
  if (opts.dryRun) {
    const finishedAt = now();
    return {
      ok: true,
      source: 'local',
      reason: 'dry_run',
      summary: {
        shipped: '(dry-run) no paid improve call',
        verify: null,
        reward: null,
        credits: null,
        files: [],
        dry_run: true,
      },
      scorecardPath: null,
      journalPath: null,
      receipt: 'skipped',
      startedAt,
      finishedAt,
    };
  }

  // No auth → local fallback (or report if fallback disabled).
  if (!creds || !creds.token) {
    if (!localFallbackEligible) {
      return {
        ok: false, source: 'none', reason: 'no_auth',
        error: shippingTick
          ? 'Not logged in and --no-fallback set. Run: atris login'
          : 'Not logged in. Plan, delegate, and dry-run modes require the hosted API; run: atris login',
        startedAt, finishedAt: now(),
      };
    }
    log('not logged in — falling back to one local mission tick');
    return finishLocalFallback('no_auth');
  }

  // A hosted backend cannot read an absolute workspace that only exists on
  // this machine. Skip the known-impossible request and use the same verified
  // local mission fallback that its workspace-path 403 would have selected.
  const apiBase = baseFn();
  if (localFallbackEligible && hostedApiCannotReachLocalWorkspace(workspace, apiBase)) {
    log('hosted backend cannot reach local workspace; falling back to one local mission tick');
    return finishLocalFallback('workspace_not_on_backend');
  }

  // Attempt the paid API tick.
  const apiPath = improveApiPath(apiBase);
  const body = buildImprovePayload({ ...opts, workspace });
  const apiResult = await apiFn(apiPath, {
    method: 'POST',
    token: creds.token,
    body,
    timeoutMs: opts.timeoutMs || DEFAULT_TIMEOUT_MS,
  });

  if (apiResult && apiResult.ok) {
    const summary = summarizeImproveResponse(apiResult.data);
    const finishedAt = now();
    // Only a real, shipping tick earns a receipt. Plan/delegate/dry-run ship
    // nothing, and an error inside an ok envelope (e.g. "workspace not found")
    // is not a shipped change — none of these should write a scorecard/journal.
    const shipped = shippingTick && !summary.error;
    if (!shipped) {
      return { ok: true, source: 'api', summary, scorecardPath: null, journalPath: null, receipt: 'skipped', startedAt, finishedAt };
    }
    const row = buildScorecardRow(summary, { source: 'api', mode: opts.mode || 'full', ts: finishedAt, member: opts.member });
    let scorecardPath = null;
    try {
      scorecardPath = writeRow(workspace, row);
    } catch (e) {
      log(`scorecard write failed: ${e.message}`);
    }
    let journalPath = null;
    try {
      journalPath = writeJournal(workspace, summary, { source: 'api', member: opts.member });
    } catch (e) {
      log(`journal write failed: ${e.message}`);
    }
    return { ok: true, source: 'api', summary, scorecardPath, journalPath, receipt: 'written', row, startedAt, finishedAt };
  }

  const decide = shouldFallbackLocal({ creds, apiResult });
  if (decide.fallback && localFallbackEligible) {
    log(`backend ${decide.reason} — falling back to one local mission tick`);
    return finishLocalFallback(decide.reason, apiResult);
  }

  // Real, answerable failure (e.g. insufficient credits, server error). Report it.
  return {
    ok: false, source: 'api', reason: decide.reason,
    error: (apiResult && (apiResult.error || `HTTP ${apiResult.status}`)) || 'request failed',
    apiResult, startedAt, finishedAt: now(),
  };
}

function formatImproveReport(result = {}) {
  const lines = [];
  if (result.source === 'api' && result.ok) {
    const s = result.summary || {};
    lines.push('improved.');
    lines.push('');
    lines.push(`  task:    ${s.shipped || '(no description returned)'}`);
    lines.push(`  verify:  ${s.verify === true ? 'pass' : s.verify === false ? 'FAIL' : 'unknown'}`);
    lines.push(`  reward:  ${s.reward != null ? s.reward : '?'}`);
    lines.push(`  credits: ${s.credits != null ? s.credits : 'billed server-side (not echoed)'}`);
    if (s.files && s.files.length) lines.push(`  files:   ${s.files.join(', ')}`);
    if (s.model) lines.push(`  model:   ${s.model}`);
    if (s.elapsedMs != null) lines.push(`  time:    ${(s.elapsedMs / 1000).toFixed(0)}s`);
    if (result.scorecardPath) {
      lines.push('');
      lines.push(`  scorecard: ${path.relative(process.cwd(), result.scorecardPath)}`);
    }
    return lines.join('\n');
  }
  if (result.source === 'local') {
    lines.push(result.ok ? 'improved (local fallback).' : 'local fallback tick failed.');
    lines.push(`  reason:  backend ${result.reason} — ran one local mission tick instead`);
    if (result.ok) {
      const s = result.summary || {};
      lines.push(`  task:    ${s.shipped || '(no description returned)'}`);
      lines.push(`  verify:  pass`);
      lines.push(`  reward:  ${s.reward != null ? s.reward : '?'}`);
      if (s.files && s.files.length) lines.push(`  files:   ${s.files.join(', ')}`);
      if (result.scorecardPath) lines.push(`  scorecard: ${path.relative(process.cwd(), result.scorecardPath)}`);
    } else if (result.error) {
      lines.push(`  error:   ${result.error}`);
    }
    return lines.join('\n');
  }
  lines.push('improve tick did not run.');
  lines.push(`  reason:  ${result.reason || 'unknown'}`);
  if (result.error) lines.push(`  error:   ${result.error}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// atris improve revisions: the gauge for the north-star metric:
// operator revisions after landing = 0. an agent landing is a commit whose
// Co-authored-by trailer matches a known agent signature (atris-builder[bot],
// claude, cursor, codex, chatgpt, openai), case-insensitive, and only on
// those trailer lines. commits with no trailer still count as human, so the
// metric overcounts revisions; accepted on purpose.
//
// if a human commit touches any of the same files within 72 hours, that
// landing failed the guarantee.
//
// renames are NOT followed: `git log --follow` is per-file and would cost one
// subprocess per file per landing, so a post-landing rename reads as "no
// overlap". that undercounts revisions slightly; accepted on purpose.

const REVISIONS_SCHEMA = 'atris.improve_revisions.v1';
const REVISION_WINDOW_HOURS = 72;
// Shared journal and state files are touched by agents and humans alike as a
// matter of routine (daily logs, now.md, run receipts), so overlap there says
// nothing about the quality of a landing. On 2026-08-21 half the "revisions"
// in a live reading were journal commits following journal commits. Only
// product-file overlap counts.
const REVISION_IGNORED_FILES = [
  /^atris\/logs\//,
  /^atris\/runs\//,
  /^atris\/team\/[^/]+\/(?:logs|now\.md)/,
  /^atris\/(?:now|thinking|TODO)\.md$/,
  /^atris\/brain\//,
  /^atris\/status\//,
  /^\.atris\//,
];

function isRevisionSignalFile(file) {
  return !REVISION_IGNORED_FILES.some((re) => re.test(String(file || '')));
}
const REVISION_WINDOW_MS = REVISION_WINDOW_HOURS * 60 * 60 * 1000;
const AGENT_TRAILER_MARKERS = [
  'atris-builder[bot]',
  'claude',
  'cursor',
  'codex',
  'chatgpt',
  'openai',
];
const DEFAULT_REVISIONS_DAYS = 14;

function isAgentCommitBody(body) {
  const markers = AGENT_TRAILER_MARKERS.map((m) => m.toLowerCase());
  for (const line of String(body || '').split(/\r?\n/)) {
    if (!/^\s*co-authored-by\s*:/i.test(line)) continue;
    const lower = line.toLowerCase();
    if (markers.some((m) => lower.includes(m))) return true;
  }
  return false;
}

function parseRevisionsArgs(argv = []) {
  const args = Array.isArray(argv) ? argv : [];
  const opts = { days: DEFAULT_REVISIONS_DAYS, json: false, help: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--help' || a === '-h') { opts.help = true; continue; }
    if (a === '--json') { opts.json = true; continue; }
    if (a === '--days') { const v = Number(args[++i]); if (Number.isFinite(v) && v > 0) opts.days = Math.round(v); continue; }
    if (a.startsWith('--days=')) { const v = Number(a.split('=')[1]); if (Number.isFinite(v) && v > 0) opts.days = Math.round(v); continue; }
  }
  return opts;
}

function gitLines(cwdRoot, gitArgs) {
  const r = spawnSync('git', gitArgs, { cwd: cwdRoot, encoding: 'utf8' });
  if (r.status !== 0) {
    const err = new Error(String(r.stderr || `git ${gitArgs[0]} exited ${r.status}`).trim());
    err.gitFailed = true;
    throw err;
  }
  return String(r.stdout || '');
}

/**
 * Files changed by one commit. Merge commits are attributed by their
 * first-parent diff (what the merge actually brought onto the mainline);
 * plain commits use diff-tree. Root commits list their initial files.
 */
function commitFiles(cwdRoot, commit) {
  const parents = commit.parents;
  const out = parents.length >= 2
    ? gitLines(cwdRoot, ['diff', '--name-only', `${commit.hash}^1`, commit.hash])
    : gitLines(cwdRoot, ['diff-tree', '--no-commit-id', '--name-only', '-r', '--root', commit.hash]);
  return out.split('\n').map((line) => line.trim()).filter(Boolean);
}

/**
 * Read the last N days of history and pair every agent landing with the
 * human commits that touched the same files within the 72-hour window.
 */
function collectRevisionSignals(root, options = {}) {
  const days = Number.isFinite(options.days) && options.days > 0 ? Math.round(options.days) : DEFAULT_REVISIONS_DAYS;
  const nowMs = options.now != null ? new Date(options.now).getTime() : Date.now();
  const sinceIso = new Date(nowMs - days * DAY_MS).toISOString();

  let raw = '';
  try {
    raw = gitLines(root, ['log', `--since=${sinceIso}`, '--date=iso-strict', '--pretty=format:%H%x1f%P%x1f%aI%x1f%s%x1f%B%x1e']);
  } catch (e) {
    // a repo with no commits yet exits non-zero on `git log`; that is the
    // empty-history case, not an error. anything else (not a repo) rethrows.
    if (!/does not have any commits|bad default revision|unknown revision/i.test(e.message)) throw e;
    raw = '';
  }

  const commits = raw.split('\x1e')
    .map((chunk) => chunk.replace(/^\n/, ''))
    .filter((chunk) => chunk.trim())
    .map((chunk) => {
      const [hash, parents, at, subject, body] = chunk.split('\x1f');
      return {
        hash: String(hash || '').trim(),
        parents: String(parents || '').trim().split(/\s+/).filter(Boolean),
        at: String(at || '').trim(),
        ms: timestampMs(at),
        subject: String(subject || '').trim(),
        isAgent: isAgentCommitBody(body),
      };
    })
    .filter((c) => c.hash && c.ms != null);

  const landings = commits.filter((c) => c.isAgent);
  // A merge that carries agent work onto the mainline is a landing action,
  // not a human correction; counting merges as revisions made the first live
  // reading say 85 percent on a healthy repo. Only single-parent human
  // commits count as revision signals.
  const humans = commits.filter((c) => !c.isAgent && c.parents.length < 2);

  const filesCache = new Map();
  const filesOf = (commit) => {
    if (!filesCache.has(commit.hash)) filesCache.set(commit.hash, commitFiles(root, commit));
    return filesCache.get(commit.hash);
  };

  const revisions = [];
  for (const landing of landings) {
    const landedFiles = new Set(filesOf(landing).filter(isRevisionSignalFile));
    if (!landedFiles.size) continue;
    const revisedBy = [];
    const touched = new Set();
    for (const human of humans) {
      if (human.ms <= landing.ms || human.ms > landing.ms + REVISION_WINDOW_MS) continue;
      const overlap = filesOf(human).filter((f) => landedFiles.has(f));
      if (!overlap.length) continue;
      revisedBy.push({ hash: human.hash, subject: human.subject, at: human.at });
      overlap.forEach((f) => touched.add(f));
    }
    if (revisedBy.length) {
      revisions.push({
        landing: { hash: landing.hash, subject: landing.subject, at: landing.at },
        revised_by: revisedBy,
        files: [...touched].sort(),
      });
    }
  }

  return {
    schema: REVISIONS_SCHEMA,
    generated_at: new Date(nowMs).toISOString(),
    days,
    window_hours: REVISION_WINDOW_HOURS,
    landings: landings.length,
    revised: revisions.length,
    rate: landings.length ? revisions.length / landings.length : 0,
    revisions,
  };
}

function listFilesPhrase(files = []) {
  const shown = files.slice(0, 3);
  const rest = files.length - shown.length;
  return rest > 0 ? `${shown.join(', ')} and ${plural(rest, 'more file')}` : shown.join(', ');
}

function formatRevisionsReport(summary = {}) {
  const days = summary.days || DEFAULT_REVISIONS_DAYS;
  if (!summary.landings) {
    return `no agent landings found in the last ${plural(days, 'day')}. nothing to measure yet.`;
  }
  const lines = [];
  lines.push(`agent landings in the last ${plural(days, 'day')}: ${summary.landings}.`);
  lines.push(`landings a human then revised: ${summary.revised}.`);
  lines.push(`revision rate: ${Math.round((summary.rate || 0) * 100)} percent. the target is zero.`);
  for (const item of Array.isArray(summary.revisions) ? summary.revisions : []) {
    lines.push('');
    lines.push(`an agent landed "${plainSentence(item.landing.subject)}". a human then changed ${listFilesPhrase(item.files)} within ${REVISION_WINDOW_HOURS} hours.`);
  }
  return lines.join('\n');
}

function showRevisionsHelp() {
  console.log(`atris improve revisions - measure operator revisions after landing

Usage:
  atris improve revisions [--days N] [--json]

Reads git history for the last N days (default ${DEFAULT_REVISIONS_DAYS}). A commit with the
atris co-author trailer is an agent landing; a later human commit touching
the same files within ${REVISION_WINDOW_HOURS} hours is a revision signal. The north-star
metric is a revision rate of zero.`);
}

function runRevisions(argv = []) {
  const opts = parseRevisionsArgs(argv);
  if (opts.help) { showRevisionsHelp(); return 0; }
  let summary;
  try {
    summary = collectRevisionSignals(process.cwd(), { days: opts.days });
  } catch (e) {
    console.log('this folder has no readable git history, so there are no landings to measure.');
    if (!e.gitFailed) console.error(`  ${e.message}`);
    return 1;
  }
  if (opts.json) console.log(JSON.stringify(summary));
  else console.log(formatRevisionsReport(summary));
  return 0;
}

function showHelp() {
  console.log(`atris improve - show the self-improvement metabolism vitals

Usage:
  atris improve
  atris improve --json
  atris improve doctor [--json] [--fix] [--check <kind>]
  atris improve revisions [--days N] [--json]
  atris improve tick [mode] [options]
  atris improve [mode|history] [options]

Modes (positional or --mode):
  full        plan + build + verify + score (default)
  plan        return the plan only, no changes
  delegate    queue the tick for a local Claude Code session
  history     show the tick history (reward trend, credits, pass rate)
  doctor      scan loop receipts and optionally file one repair mission
  revisions   measure operator revisions after agent landings (target: zero)

Options:
  --member <name>  attribute the tick to a member (the loop's owner)
  --model <id>     override the model (e.g. claude-sonnet-4-6)
  --dry-run        plan and run but do not commit
  --no-fallback    do not fall back to a local tick if the backend is down
  --workspace <p>  workspace path (default: cwd)
  --timeout <sec>  request timeout in seconds (default: 300)
  --check <kind>   exit 0 when the doctor finding is absent, or 1 when present
  --json           machine-readable output (for the member loop)
  -h, --help       this help

Calls POST /api/improve, which ships one verifiable change and deducts
Atris credits per successful tick. Writes a per-tick scorecard to
.atris/state/scorecards.jsonl. Falls back to one local mission tick when
the backend is unreachable or you are not logged in.`);
}

function isBareVitalsArgs(argv = []) {
  return argv.length === 0 || (argv.length === 1 && argv[0] === '--json');
}

const LOOP_DOCTOR_OPEN_STATUSES = new Set(['planning', 'ready', 'running', 'paused', 'blocked']);

function loopDoctorKey(finding) {
  return `[loop-doctor:${finding.kind}]`;
}

function openLoopDoctorMission(root, finding) {
  const key = loopDoctorKey(finding);
  const rows = readJsonlFile(path.join(root, '.atris', 'state', 'missions.jsonl'));
  const latest = new Map();
  rows.forEach((row, index) => {
    const mission = row && row.mission && typeof row.mission === 'object' ? row.mission : row;
    if (mission && typeof mission === 'object') latest.set(String(mission.id || `row-${index}`), mission);
  });
  return [...latest.values()].find((mission) => LOOP_DOCTOR_OPEN_STATUSES.has(String(mission.status || '').toLowerCase())
    && String(mission.objective || '').includes(key)) || null;
}

function formatLoopDoctor(findings, fix = null, closed = []) {
  const lines = [`loop doctor: ${findings.length} finding${findings.length === 1 ? '' : 's'}`];
  findings.forEach((finding, index) => {
    lines.push(`${index + 1}. ${finding.kind}: ${finding.evidence.detail} (${finding.count})`);
    lines.push(`   repair: ${finding.suggested_mission.objective}`);
  });
  if (!findings.length) lines.push('the recent improve-loop receipts are clean.');
  if (fix && fix.action === 'mission_started') lines.push(`filed one mission: ${fix.mission.id}`);
  if (fix && fix.action === 'mission_exists') lines.push(`no mission filed: ${fix.mission.id} already covers the top finding.`);
  if (Array.isArray(closed) && closed.length) {
    lines.push(`credited ${closed.length} verified repair${closed.length === 1 ? '' : 's'}: ${closed.map((row) => row.kind).join(', ')}`);
  }
  return lines.join('\n');
}

// Close the reward loop the doctor opens. When it files a repair it writes a
// reward-0 loop_doctor row; the fix only earns once its finding is provably
// gone. This reconciles those open rows against the current findings: a filed
// row whose kind no longer fires gets one closing credit, so the scorecard
// reads filed then paid instead of a pile of zero-reward filings. Deduped by
// mission id so a finding that clears stays closed even if it flickers back.
function reconcileLoopDoctorRewards(root, findings, now, appendScorecard) {
  // Read the raw rows, not readTickHistory: that filters to improve_tick
  // schema and would drop the loop_doctor rows this reconciliation is about.
  const rows = readJsonlFile(path.join(expandHome(root), '.atris', 'state', 'scorecards.jsonl'));
  const openByMission = new Map();
  const closedMissions = new Set();
  for (const row of rows) {
    if (!row || row.schema !== 'atris.loop_doctor.v1' || !row.mission_id) continue;
    if (row.closed === true) { closedMissions.add(String(row.mission_id)); continue; }
    if (Number(row.reward) === 0) openByMission.set(String(row.mission_id), row);
  }
  const liveKinds = new Set(findings.map((finding) => finding.kind));
  const closed = [];
  for (const [missionId, row] of openByMission) {
    if (closedMissions.has(missionId)) continue;
    if (liveKinds.has(row.kind)) continue; // finding still fires, repair not proven yet
    const closingRow = {
      schema: 'atris.loop_doctor.v1',
      ts: now.toISOString(),
      source: 'loop_doctor',
      kind: row.kind,
      mission_id: missionId,
      reward: 3,
      closed: true,
      note: 'repair verified: the finding it filed against is no longer present',
    };
    appendScorecard(root, closingRow);
    closedMissions.add(missionId);
    closed.push(closingRow);
  }
  return closed;
}

function runLoopDoctor(argv = [], deps = {}) {
  const args = Array.isArray(argv) ? argv : [];
  const json = args.includes('--json');
  const fixRequested = args.includes('--fix');
  const checkIndex = args.indexOf('--check');
  const checkRequested = checkIndex !== -1;
  const checkKind = checkRequested ? String(args[checkIndex + 1] || '').trim() : null;
  const root = process.cwd();
  const scan = deps.scanLoopReceipts || require('../lib/loop-doctor').scanLoopReceipts;
  const findings = scan({ root, now: deps.now || new Date() });
  let fix = null;

  if (checkRequested) {
    const finding = checkKind && findings.find((item) => item.kind === checkKind);
    const check = {
      kind: checkKind,
      ok: Boolean(checkKind) && !finding,
      reason: !checkKind ? 'missing finding kind' : (finding ? `${checkKind} is still present` : null),
    };
    const payload = { schema: 'atris.loop_doctor.v1', findings, fix, check };
    if (json) console.log(JSON.stringify(payload));
    else if (check.ok) console.log(`loop doctor check passed: no ${checkKind} finding.`);
    else console.log(`loop doctor check failed: ${check.reason}.`);
    return payload;
  }

  // Credit any past filing whose finding has since cleared. This runs on plain
  // `doctor` and `doctor --fix`, never on `--check` (a pure verifier that must
  // not write), so the reward closes on the next observation after a repair.
  const reconcileNow = deps.now || new Date();
  const reconcileAppend = deps.appendScorecardRow || appendScorecardRow;
  const closed = reconcileLoopDoctorRewards(deps.workspace || root, findings, reconcileNow, reconcileAppend);

  if (fixRequested && findings.length) {
    const finding = findings[0];
    const existing = openLoopDoctorMission(root, finding);
    if (existing) {
      fix = { action: 'mission_exists', finding_kind: finding.kind, mission: existing };
    } else {
      const suggested = finding.suggested_mission;
      const objective = `${loopDoctorKey(finding)} ${suggested.objective}`;
      const start = deps.startMission || require('./mission').startMission;
      const started = start([
        objective,
        '--owner', suggested.owner,
        '--verify', suggested.verifier,
        '--cadence', suggested.cadence,
        '--runner', 'auto',
        '--always-on',
      ], { silent: true });
      fix = { action: 'mission_started', finding_kind: finding.kind, mission: started.mission };
      const workspace = deps.workspace || root;
      const appendScorecard = deps.appendScorecardRow || appendScorecardRow;
      appendScorecard(workspace, {
        schema: 'atris.loop_doctor.v1',
        ts: (deps.now || new Date()).toISOString(),
        source: 'loop_doctor',
        kind: finding.kind,
        mission_id: started.mission.id,
        reward: 0,
        note: 'repair filed; reward is earned by the repair tick, not the filing',
      });
    }
  }

  const payload = { schema: 'atris.loop_doctor.v1', findings, fix, closed };
  if (json) console.log(JSON.stringify(payload));
  else console.log(formatLoopDoctor(findings, fix, closed));
  return payload;
}

async function run(argv = [], deps = {}) {
  const args = Array.isArray(argv) ? [...argv] : [];
  if (args[0] === 'doctor') {
    const result = runLoopDoctor(args.slice(1), deps);
    return result.check && !result.check.ok ? 1 : 0;
  }
  if (args[0] === 'revisions') {
    return runRevisions(args.slice(1));
  }
  if (isBareVitalsArgs(args)) {
    const vitals = (deps.collectImproveVitals || collectImproveVitals)({ workspace: process.cwd() }, deps);
    if (args.includes('--json')) console.log(JSON.stringify(vitals));
    else console.log(formatImproveVitals(vitals));
    // Keep the live page in step with what the terminal just said.
    try {
      const file = require('../lib/improve-vitals-html').writeVitalsHtml(process.cwd(), deps);
      if (!args.includes('--json')) console.log(`\nlive page: ${file} (open it once, it refreshes itself)`);
    } catch { /* page is a bonus, never a failure */ }
    return 0;
  }

  const routedArgs = args[0] === 'tick' ? args.slice(1) : args;
  const opts = parseImproveArgs(routedArgs);
  if (opts.help) { showHelp(); return 0; }

  if (opts.history) {
    const summary = summarizeTickHistory(readTickHistory(opts.workspace));
    if (opts.json) console.log(JSON.stringify(summary));
    else console.log(formatTickHistory(summary));
    return 0;
  }

  const improveFn = deps.runImprove || runImprove;
  const result = await improveFn(opts, {
    log: opts.json ? () => {} : (m) => console.error(`  ${m}`),
  });

  if (opts.json) {
    console.log(JSON.stringify(result));
  } else {
    console.log(formatImproveReport(result));
  }
  return result.ok ? 0 : 1;
}

module.exports = {
  run,
  runImprove,
  parseImproveArgs,
  buildImprovePayload,
  summarizeImproveResponse,
  shouldFallbackLocal,
  buildScorecardRow,
  appendScorecardRow,
  appendTickToJournal,
  expandHome,
  collectImproveVitals,
  formatImproveVitals,
  isBareVitalsArgs,
  readTickHistory,
  summarizeTickHistory,
  formatTickHistory,
  improveApiPath,
  runLoopDoctor,
  collectRevisionSignals,
  formatRevisionsReport,
  isAgentCommitBody,
  runLocalFallback,
  summarizeLocalMissionRun,
  LOCAL_FALLBACK_ARGS,
  localFallbackArgs,
  SCORECARD_SCHEMA,
  IMPROVE_VITALS_SCHEMA,
};
