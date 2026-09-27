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
const OUTCOMES = Object.freeze(['landed', 'failed', 'stalled', 'credit out']);
const DEFAULT_DAYS = 7;
const TAIL_BYTES = 512 * 1024;
const JOB_ALIASES = Object.freeze({ navigator: 'search', executor: 'build', builder: 'build', validator: 'review', reviewer: 'review' });

function rosterRunsPath(root = process.cwd()) {
  return path.join(root, RUNS_FILE);
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
  };
  for (const [key, value] of Object.entries(optional)) if (value) record[key] = value;
  const cap = wholeNumber(input.max_seconds);
  if (cap) record.max_seconds = cap;
  const seconds = Number(input.seconds);
  if (Number.isFinite(seconds) && seconds >= 0) record.seconds = Math.round(seconds);
  const tokens = wholeNumber(input.tokens);
  if (input.tokens !== undefined && input.tokens !== null && tokens !== null) record.tokens = tokens;
  if (typeof input.cost_usd === 'number' && Number.isFinite(input.cost_usd)) record.cost_usd = input.cost_usd;
  return record;
}

function appendRosterRun(root = process.cwd(), input = {}, options = {}) {
  try {
    const record = normalizeRun(input, options);
    const file = rosterRunsPath(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
    return record;
  } catch {
    return null;
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

// Runs from the last `days` days, oldest first. A missing file or a bad line
// is never an error.
function readRosterRuns(root = process.cwd(), { now, days = DEFAULT_DAYS } = {}) {
  const since = nowMs(now) - Math.max(0, Number(days) || DEFAULT_DAYS) * 86400000;
  const rows = [];
  for (const line of readTail(rosterRunsPath(root)).split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (!row || typeof row !== 'object' || !row.engine || !OUTCOMES.includes(row.outcome)) continue;
    const at = Date.parse(row.at);
    if (!Number.isFinite(at) || at < since) continue;
    rows.push(row);
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

function outcomeText(run) {
  let text = run.outcome;
  if (run.detail && run.detail !== run.outcome) text = run.outcome === 'stalled' && /^stalled\b/.test(run.detail) ? run.detail : `${run.outcome}, ${run.detail}`;
  if (run.handed_over_to) text += `, handed over to ${run.handed_over_to}`;
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
  RUNS_FILE,
  OUTCOMES,
  DEFAULT_DAYS,
  rosterRunsPath,
  jobName,
  parseRunUsage,
  normalizeRun,
  appendRosterRun,
  appendRosterAttempts,
  readRosterRuns,
  workerRuns,
  summarizeRuns,
  durationText,
  renderRunLine,
  recentRuns,
};
