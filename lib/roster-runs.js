'use strict';

// One line per run launched from a roster pick, so the owner can judge each
// tool and model on real work instead of memory. A line says when, which job,
// which member (if any), the engine, model, effort, time cap, seconds taken,
// and how it ended: landed, failed, stalled, credit out, and who took over
// when it was handed on. Tokens and cost appear only when the tool printed
// them in output we already capture; nothing is guessed.
//
// Writing never throws into the run that called it, and reading only looks
// at the tail of the file, skipping any line that does not parse.

const fs = require('fs');
const path = require('path');

const RUNS_FILE = path.join('.atris', 'state', 'roster_runs.jsonl');
// Lines written while the lock was held by someone else wait here; the next
// locked writer folds them into the log and readers see them either way.
const PENDING_FILE = path.join('.atris', 'state', 'roster_runs.pending.jsonl');
const OUTCOMES = Object.freeze(['landed', 'failed', 'stalled', 'credit out']);
const DEFAULT_DAYS = 7;
const TAIL_BYTES = 512 * 1024;
// The file is trimmed once an append takes it past 2 MB, keeping the newest
// whole lines that fit in 1 MB: weeks of runs, far more than any view reads.
const RUNS_ROTATE_BYTES = 2 * 1024 * 1024;
const RUNS_KEEP_BYTES = 1024 * 1024;
const JOB_ALIASES = Object.freeze({ navigator: 'search', executor: 'build', builder: 'build', validator: 'review', reviewer: 'review' });

function rosterRunsPath(root = process.cwd()) {
  return path.join(root, RUNS_FILE);
}

function pendingRunsPath(root = process.cwd()) {
  return path.join(root, PENDING_FILE);
}

function nowMs(now) {
  if (now instanceof Date) return now.getTime();
  if (typeof now === 'function') return nowMs(now());
  const value = Number(now);
  return Number.isFinite(value) && now !== null && now !== undefined ? value : Date.now();
}

function clean(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

// "executor", "small-build", and "Small Build" all read as the job's name.
function jobName(value) {
  const text = clean(value).toLowerCase().replace(/[-_]+/g, ' ');
  return JOB_ALIASES[text] || text;
}

function wholeNumber(value) {
  const number = Number(String(value == null ? '' : value).replace(/,/g, ''));
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : null;
}

function usageTotal(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const parts = ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']
    .map((key) => wholeNumber(usage[key]))
    .filter((value) => value !== null);
  return parts.length ? parts.reduce((sum, value) => sum + value, 0) : null;
}

// Tokens and cost the tool itself reported, or nothing. Claude's json result
// carries usage and total_cost_usd; codex prints "tokens used" and the count.
function parseRunUsage({ usage = null, cost_usd = null, stdout = '', stderr = '' } = {}) {
  const found = {};
  const direct = usageTotal(usage);
  if (direct !== null) found.tokens = direct;
  if (typeof cost_usd === 'number' && Number.isFinite(cost_usd)) found.cost_usd = cost_usd;
  const text = `${String(stdout || '')}\n${String(stderr || '')}`;
  if (found.tokens === undefined) {
    for (const line of text.split(/\r?\n/).reverse()) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('{') || !trimmed.includes('"usage"')) continue;
      try {
        const event = JSON.parse(trimmed);
        const tokens = usageTotal(event && event.usage);
        if (tokens === null) continue;
        found.tokens = tokens;
        if (found.cost_usd === undefined && typeof event.total_cost_usd === 'number') found.cost_usd = event.total_cost_usd;
        break;
      } catch {}
    }
  }
  if (found.tokens === undefined) {
    const codex = /tokens used[:\s]*([\d,]+)/gi;
    let match;
    let last = null;
    while ((match = codex.exec(text))) last = match[1];
    const tokens = wholeNumber(last);
    if (last && tokens !== null) found.tokens = tokens;
  }
  return found;
}

// One normalized line. Empty fields stay out so a line only says what we know.
function normalizeRun(input = {}, { now } = {}) {
  const outcome = OUTCOMES.includes(input.outcome) ? input.outcome : 'failed';
  const record = {
    at: clean(input.at) || new Date(nowMs(now)).toISOString(),
    job: jobName(input.job) || 'build',
    engine: clean(input.engine) || 'unknown',
    outcome,
  };
  const optional = {
    member: clean(input.member),
    model: clean(input.model),
    effort: clean(input.effort),
    task: clean(input.task),
    detail: clean(input.detail).slice(0, 240),
    handed_over_to: clean(input.handed_over_to),
    source: clean(input.source),
    prep: clean(input.prep).slice(0, 160),
  };
  for (const [key, value] of Object.entries(optional)) if (value) record[key] = value;
  const cap = wholeNumber(input.max_seconds);
  if (cap) record.max_seconds = cap;
  const seconds = Number(input.seconds);
  if (Number.isFinite(seconds) && seconds >= 0) record.seconds = Math.round(seconds);
  const tokens = wholeNumber(input.tokens);
  if (input.tokens !== undefined && input.tokens !== null && tokens !== null) record.tokens = tokens;
  if (typeof input.cost_usd === 'number' && Number.isFinite(input.cost_usd)) record.cost_usd = input.cost_usd;
  for (const key of ['brief_lines', 'brief_bytes']) {
    const value = wholeNumber(input[key]);
    if (input[key] !== undefined && input[key] !== null && value !== null) record[key] = value;
  }
  return record;
}

// Appends and the trim share one small lock: a file created exclusively next
// to the log. Without it, a line appended between the trim reading the tail
// and renaming its copy over the log would vanish. A writer waits at most
// RUNS_LOCK_WAIT_MS; a lock older than RUNS_LOCK_STALE_MS was left by a
// writer that died and is taken back. When the lock can't be had, the line
// waits in a side file the next locked writer folds into the log, so a trim
// in progress can never drop it and the record stays visible to readers.
const RUNS_LOCK_WAIT_MS = 1000;
const RUNS_LOCK_STALE_MS = 5000;
const LOCK_PAUSE_MS = 10;

function pause(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch {}
}

function takeLock(file) {
  const lock = `${file}.lock`;
  const deadline = Date.now() + RUNS_LOCK_WAIT_MS;
  for (;;) {
    try {
      const fd = fs.openSync(lock, 'wx');
      try { fs.writeSync(fd, String(process.pid)); } finally { fs.closeSync(fd); }
      return lock;
    } catch (error) {
      if (!error || error.code !== 'EEXIST') return null;
    }
    // The deadline is checked every pass: a lock that is stale but cannot
    // be removed must end the wait, not spin on it forever.
    if (Date.now() >= deadline) return null;
    try {
      if (Date.now() - fs.statSync(lock).mtimeMs > RUNS_LOCK_STALE_MS) fs.rmSync(lock, { force: true });
    } catch {}
    pause(LOCK_PAUSE_MS);
  }
}

function releaseLock(lock) {
  if (lock) try { fs.rmSync(lock, { force: true }); } catch {}
}

// Past the size cap, keep only the newest whole lines that fit in the keep
// size, written to a temp file and renamed over the old one in one step.
// Only called while holding the lock.
function trimRunsFile(file) {
  const size = fs.statSync(file).size;
  if (size <= RUNS_ROTATE_BYTES) return;
  const text = readTail(file, RUNS_KEEP_BYTES);
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temp, text, 'utf8');
    fs.renameSync(temp, file);
  } catch {
    try { fs.rmSync(temp, { force: true }); } catch {}
  }
}

// Only called while holding the lock. The side file is renamed aside first,
// so a line appended to it mid-fold lands in a fresh file the next locked
// writer picks up; then its lines join the log ahead of this writer's own.
function foldPendingRuns(root, file) {
  const pending = pendingRunsPath(root);
  const staged = `${pending}.${process.pid}.fold`;
  try {
    fs.renameSync(pending, staged);
  } catch {
    return;
  }
  try {
    const text = fs.readFileSync(staged, 'utf8');
    if (text.trim()) fs.appendFileSync(file, text, 'utf8');
  } catch {
    // The log refused it; the lines go back for the next locked writer.
    try { fs.appendFileSync(pending, fs.readFileSync(staged, 'utf8'), 'utf8'); } catch {}
  }
  try { fs.rmSync(staged, { force: true }); } catch {}
}

function appendRosterRun(root = process.cwd(), input = {}, options = {}) {
  let lock = null;
  try {
    const record = normalizeRun(input, options);
    const file = rosterRunsPath(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    lock = takeLock(file);
    const line = `${JSON.stringify(record)}\n`;
    if (!lock) {
      // A trim may be mid-flight behind that lock, so the line waits in the
      // side file the next locked writer folds into the log.
      fs.appendFileSync(pendingRunsPath(root), line, 'utf8');
      return record;
    }
    foldPendingRuns(root, file);
    fs.appendFileSync(file, line, 'utf8');
    try { trimRunsFile(file); } catch {}
    return record;
  } catch {
    return null;
  } finally {
    releaseLock(lock);
  }
}

// Several attempts at one job, oldest first. Each attempt that was followed by
// another names who took over.
function appendRosterAttempts(root, attempts = [], shared = {}, options = {}) {
  const list = (attempts || []).filter(Boolean);
  return list.map((attempt, index) => appendRosterRun(root, {
    ...shared,
    ...attempt,
    ...(index + 1 < list.length && list[index + 1].engine ? { handed_over_to: list[index + 1].engine } : {}),
  }, options));
}

// The last few hundred KB only: the file grows forever and the roster view
// never needs more than recent days.
function readTail(file, bytes = TAIL_BYTES) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buffer = Buffer.alloc(size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    const text = buffer.toString('utf8');
    return start > 0 ? text.slice(text.indexOf('\n') + 1) : text;
  } catch {
    return '';
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
  }
}

const TEXT_FIELDS = Object.freeze(['at', 'job', 'engine', 'outcome', 'member', 'model', 'effort', 'task', 'detail', 'handed_over_to', 'source', 'prep']);
const NUMBER_FIELDS = Object.freeze(['max_seconds', 'seconds', 'tokens', 'cost_usd', 'brief_lines', 'brief_bytes']);

// A line as read back, with every known field its expected type: text
// trimmed or dropped, numbers finite or dropped ("0.42" reads as 0.42), so a
// hand-edited line can never break the views.
function readableRun(row) {
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    if (TEXT_FIELDS.includes(key)) {
      if (typeof value !== 'string') continue;
      const text = value.trim();
      if (text) out[key] = text;
    } else if (NUMBER_FIELDS.includes(key)) {
      const number = typeof value === 'number' ? value
        : typeof value === 'string' && value.trim() ? Number(value.trim())
          : NaN;
      if (Number.isFinite(number) && number >= 0) out[key] = number;
    }
  }
  return out;
}

// Runs from the last `days` days, oldest first, read from the last
// `tailBytes` of the file. A missing file or a bad line is never an error.
function readRosterRuns(root = process.cwd(), { now, days = DEFAULT_DAYS, tailBytes = TAIL_BYTES } = {}) {
  const since = nowMs(now) - Math.max(0, Number(days) || DEFAULT_DAYS) * 86400000;
  const rows = [];
  const bytes = Number(tailBytes) > 0 ? Number(tailBytes) : TAIL_BYTES;
  // The side file holds lines not yet folded into the log; reading both
  // keeps a held lock from hiding runs.
  for (const file of [rosterRunsPath(root), pendingRunsPath(root)]) {
    for (const line of readTail(file, bytes).split(/\r?\n/)) {
      if (!line.trim()) continue;
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
      row = readableRun(row);
      if (!row.engine || !OUTCOMES.includes(row.outcome)) continue;
      const at = Date.parse(row.at);
      if (!Number.isFinite(at) || at < since) continue;
      rows.push(row);
    }
  }
  return rows;
}

function median(values) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function durationText(seconds) {
  const value = Math.round(Number(seconds) || 0);
  if (value < 60) return `${value}s`;
  if (value < 3600) return `${Math.round(value / 60)} min`;
  const hours = Math.floor(value / 3600);
  const minutes = Math.round((value % 3600) / 60);
  return minutes ? `${hours} h ${minutes} min` : `${hours} h`;
}

// The runs that belong to one worker on one job. A worker with a pinned model
// counts only runs on that model; with no pin, every run of the engine counts.
function workerRuns(runs, { job, engine, model = '' } = {}) {
  const wantJob = jobName(job);
  const wantEngine = clean(engine);
  const wantModel = clean(model).toLowerCase();
  return (runs || []).filter((run) => jobName(run.job) === wantJob
    && run.engine === wantEngine
    && (!wantModel || clean(run.model).toLowerCase() === wantModel));
}

// "last 7 days: 9 runs, 7 landed, 1 stalled, 1 failed, median 11 min", or
// null when there are no runs.
function summarizeRuns(runs, { days = DEFAULT_DAYS } = {}) {
  const list = runs || [];
  if (!list.length) return null;
  const count = (outcome) => list.filter((run) => run.outcome === outcome).length;
  const summary = {
    days,
    runs: list.length,
    landed: count('landed'),
    failed: count('failed'),
    stalled: count('stalled'),
    credit_out: count('credit out'),
    handed_over: list.filter((run) => run.handed_over_to).length,
    median_seconds: median(list.map((run) => Number(run.seconds)).filter((value) => value >= 0)),
  };
  const tokens = list.map((run) => run.tokens).filter((value) => Number.isFinite(value));
  if (tokens.length) summary.tokens = tokens.reduce((sum, value) => sum + value, 0);
  const parts = [`${summary.runs} run${summary.runs === 1 ? '' : 's'}`];
  if (summary.landed) parts.push(`${summary.landed} landed`);
  if (summary.stalled) parts.push(`${summary.stalled} stalled`);
  if (summary.failed) parts.push(`${summary.failed} failed`);
  if (summary.credit_out) parts.push(`${summary.credit_out} credit out`);
  if (summary.median_seconds !== null) parts.push(`median ${durationText(summary.median_seconds)}`);
  summary.text = `last ${days} day${days === 1 ? '' : 's'}: ${parts.join(', ')}`;
  return summary;
}

function clockText(at) {
  const date = new Date(at);
  if (!Number.isFinite(date.getTime())) return String(at || '');
  const day = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).toLowerCase();
  return `${day} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function briefSizeText(bytes) {
  const value = Number(bytes) || 0;
  return value < 1024 ? `${value} bytes` : `${(value / 1024).toFixed(1).replace(/\.0$/, '')} KB`;
}

function outcomeText(run) {
  let text = run.outcome;
  if (run.detail && run.detail !== run.outcome) text = run.outcome === 'stalled' && /^stalled\b/.test(run.detail) ? run.detail : `${run.outcome}, ${run.detail}`;
  if (run.handed_over_to) text += `, handed over to ${run.handed_over_to}`;
  if (run.prep) text += `, ${run.prep}${run.brief_bytes ? ` (${briefSizeText(run.brief_bytes)} brief)` : ''}`;
  return text;
}

// One plain line per attempt.
function renderRunLine(run) {
  const worker = [run.engine, run.model, run.effort].filter(Boolean).join(' ');
  const facts = [
    run.seconds !== undefined ? durationText(run.seconds) : '',
    run.max_seconds ? `cap ${durationText(run.max_seconds)}` : '',
    run.tokens !== undefined ? `${run.tokens.toLocaleString('en-US')} tokens` : '',
    run.cost_usd !== undefined ? `$${run.cost_usd.toFixed(2)}` : '',
  ].filter(Boolean).join(', ');
  const who = [run.job, run.member ? `for ${run.member}` : '', run.task].filter(Boolean).join(' ');
  return `${clockText(run.at)}  ${who}: ${worker}${facts ? ` (${facts})` : ''}, ${outcomeText(run)}`;
}

// Newest first, at most `limit`, optionally one job only.
function recentRuns(runs, { job = '', limit = 20 } = {}) {
  const wantJob = job ? jobName(job) : '';
  return (runs || [])
    .filter((run) => !wantJob || jobName(run.job) === wantJob)
    .map((run, index) => ({ run, index }))
    .sort((a, b) => (Date.parse(b.run.at) - Date.parse(a.run.at)) || (b.index - a.index))
    .slice(0, limit)
    .map(({ run }) => run);
}

module.exports = {
  OUTCOMES,
  DEFAULT_DAYS,
  RUNS_ROTATE_BYTES,
  RUNS_KEEP_BYTES,
  RUNS_LOCK_WAIT_MS,
  RUNS_LOCK_STALE_MS,
  rosterRunsPath,
  jobName,
  parseRunUsage,
  appendRosterRun,
  appendRosterAttempts,
  readRosterRuns,
  workerRuns,
  summarizeRuns,
  renderRunLine,
  recentRuns,
};
