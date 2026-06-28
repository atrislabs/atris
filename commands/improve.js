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
 * or the user is not logged in, it falls back to a local autopilot tick
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
const DEFAULT_TIMEOUT_MS = 300000;
const VALID_MODES = new Set(['full', 'plan', 'delegate']);

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
    elapsedMs: typeof d.elapsed_ms === 'number' ? d.elapsed_ms : null,
    scorecardWritten: d.scorecard_written === true,
    error: d.error || null,
  };
}

/**
 * Decide whether to fall back to a local autopilot tick. Fallback only when
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
  return { fallback: false, reason: `api_error_${apiResult.status}` };
}

function buildScorecardRow(summary = {}, meta = {}) {
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

function firstStringField(obj, fields = []) {
  if (!obj || typeof obj !== 'object') return '';
  for (const field of fields) {
    const value = obj[field];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function normalizeImproveError(error) {
  if (!error) return null;
  if (typeof error === 'string') return { message: error, next: null };
  if (error instanceof Error) return { message: error.message, next: null };
  if (typeof error !== 'object') return { message: String(error), next: null };

  const detail = error.detail && typeof error.detail === 'object' ? error.detail : null;
  const message = firstStringField(error, ['error', 'message', 'detail'])
    || firstStringField(detail, ['error', 'message'])
    || JSON.stringify(error);
  const next = firstStringField(error, ['recommended_next_action', 'next_action'])
    || firstStringField(detail, ['recommended_next_action', 'next_action']);
  return { message, next: next || null };
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

function runLocalFallback(opts = {}) {
  const bin = resolveAtrisBin();
  const isScript = bin.endsWith('.js');
  const cmd = isScript ? process.execPath : bin;
  const argv = (isScript ? [bin] : []).concat(['autopilot', '--auto', '--iterations=1']);
  const r = spawnSync(cmd, argv, {
    cwd: opts.workspace || process.cwd(),
    encoding: 'utf8',
    env: process.env,
    stdio: opts.json ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    timeout: Math.max(60, Number(opts.timeoutSec) || 600) * 1000,
  });
  return {
    ok: r.status === 0,
    status: r.status == null ? 1 : r.status,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
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

  // No auth → local fallback (or report if fallback disabled).
  if (!creds || !creds.token) {
    if (!opts.fallback) {
      return {
        ok: false, source: 'none', reason: 'no_auth',
        error: 'Not logged in and --no-fallback set. Run: atris login',
        startedAt, finishedAt: now(),
      };
    }
    log('not logged in — falling back to a local autopilot tick');
    const local = localFn({ workspace, json: opts.json, timeoutSec });
    return { ok: local.ok, source: 'local', reason: 'no_auth', local, startedAt, finishedAt: now() };
  }

  // Attempt the paid API tick.
  const apiPath = improveApiPath(baseFn());
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
    const shipped = (opts.mode || 'full') === 'full' && !opts.dryRun && !summary.error;
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
  if (decide.fallback && opts.fallback) {
    log(`backend ${decide.reason} — falling back to a local autopilot tick`);
    const local = localFn({ workspace, json: opts.json, timeoutSec });
    return { ok: local.ok, source: 'local', reason: decide.reason, local, apiResult, startedAt, finishedAt: now() };
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
    lines.push(`  reason:  backend ${result.reason} — ran a local autopilot tick instead`);
    if (result.local && !result.ok && result.local.stderr) {
      lines.push(`  error:   ${result.local.stderr.trim().split('\n').slice(-1)[0]}`);
    }
    return lines.join('\n');
  }
  lines.push('improve tick did not run.');
  lines.push(`  reason:  ${result.reason || 'unknown'}`);
  if (result.error) {
    const error = normalizeImproveError(result.error);
    if (error && error.message) lines.push(`  error:   ${error.message}`);
    if (error && error.next) lines.push(`  next:    ${error.next}`);
  }
  return lines.join('\n');
}

function showHelp() {
  console.log(`atris improve — run one paid RL improvement tick

Usage:
  atris improve [mode] [options]

Modes (positional or --mode):
  full        plan + build + verify + score (default)
  plan        return the plan only, no changes
  delegate    queue the tick for a local Claude Code session
  history     show the tick history (reward trend, credits, pass rate)

Options:
  --member <name>  attribute the tick to a member (the loop's owner)
  --model <id>     override the model (e.g. claude-sonnet-4-6)
  --dry-run        plan and run but do not commit
  --no-fallback    do not fall back to a local tick if the backend is down
  --workspace <p>  workspace path (default: cwd)
  --timeout <sec>  request timeout in seconds (default: 300)
  --json           machine-readable output (for the member loop)
  -h, --help       this help

Calls POST /api/improve, which ships one verifiable change and deducts
Atris credits per successful tick. Writes a per-tick scorecard to
.atris/state/scorecards.jsonl. Falls back to a local autopilot tick when
the backend is unreachable or you are not logged in.`);
}

async function run(argv = []) {
  const opts = parseImproveArgs(argv);
  if (opts.help) { showHelp(); return 0; }

  if (opts.history) {
    const summary = summarizeTickHistory(readTickHistory(opts.workspace));
    if (opts.json) console.log(JSON.stringify(summary));
    else console.log(formatTickHistory(summary));
    return 0;
  }

  const result = await runImprove(opts, {
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
  readTickHistory,
  summarizeTickHistory,
  formatTickHistory,
  normalizeImproveError,
  improveApiPath,
  formatImproveReport,
  runLocalFallback,
  SCORECARD_SCHEMA,
};
