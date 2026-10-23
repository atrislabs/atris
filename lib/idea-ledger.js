'use strict';

// The idea outcome ledger and the score read from it.
//
// Every idea tick that picks up an idea appends one JSON line here saying how
// it ended: landed, refused (a safety rail said no), failed (the build, the
// review, the checks, or the push did not get through), or reverted. The
// score `atris idea` prints comes only from these lines, and the tick reads
// the same lines to notice a failure that keeps coming back.
//
// This file judges the loop. A built change that edits it is refused before
// landing (see JUDGE_PATHS in lib/idea-inbox.js), so the loop can never raise
// its own score by rewriting how the score is counted.
//
// Storage follows the usual `.atris/state/<name>.jsonl` convention: append
// only, one `atris.idea_outcome.v1` row per line, gitignored.

const fs = require('fs');
const path = require('path');

const OUTCOMES = Object.freeze(['landed', 'refused', 'failed', 'reverted']);
const STAGES = Object.freeze(['intake', 'build', 'review', 'checks', 'push']);
const DAY_MS = 24 * 60 * 60 * 1000;
const SCORE_WINDOW_DAYS = 7;
const REPEAT_COUNT = 2;

function outcomesFile(root) {
  return path.join(path.resolve(root || '.'), '.atris', 'state', 'idea_outcomes.jsonl');
}

function short(value, limit = 60) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit - 3).trimEnd()}...` : text;
}

function timeMs(value) {
  const ms = Date.parse(value || '');
  return Number.isFinite(ms) ? ms : null;
}

function minutesBetween(from, to) {
  const a = timeMs(from);
  const b = timeMs(to);
  if (a === null || b === null || b < a) return null;
  return Math.round(((b - a) / 60000) * 10) / 10;
}

// Appends one outcome row. `idea` is the inbox row the tick worked on.
function recordOutcome(root, {
  idea,
  outcome,
  stage = null,
  cause = '',
  started = null,
  finished = new Date().toISOString(),
  taskId = null,
  link = null,
} = {}) {
  if (!idea || !idea.id) throw new Error('an outcome needs the idea it belongs to');
  if (!OUTCOMES.includes(outcome)) throw new Error(`unknown idea outcome: ${outcome}`);
  if (stage !== null && !STAGES.includes(stage)) throw new Error(`unknown idea stage: ${stage}`);
  const repo = path.resolve(root || '.');
  const row = {
    schema: 'atris.idea_outcome.v1',
    id: idea.id,
    n: idea.n || null,
    repo,
    idea_at: idea.at || null,
    started: started || finished,
    finished,
    minutes: minutesBetween(started || finished, finished),
    outcome,
    cause: short(cause) || null,
    stage: outcome === 'landed' ? null : stage,
    attempt: Number(idea.attempts || 0) || null,
    ...(taskId ? { task_id: taskId } : {}),
    ...(link ? { link } : {}),
    ...(idea.tag ? { tag: idea.tag } : {}),
  };
  const file = outcomesFile(repo);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(row)}\n`, 'utf8');
  return row;
}

function readOutcomes(root) {
  let text = '';
  try {
    text = fs.readFileSync(outcomesFile(root), 'utf8');
  } catch {
    return [];
  }
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row && row.schema === 'atris.idea_outcome.v1' && row.id && OUTCOMES.includes(row.outcome)) rows.push(row);
    } catch {}
  }
  return rows;
}

// Two failures are "the same" when they stopped at the same stage and their
// causes read the same once paths, numbers, quotes, and ids are taken out.
// Plain on purpose, like the refuse rules: easy to read, easy to test.
function causeKey(stage, cause) {
  const words = String(cause || '').toLowerCase()
    .replace(/"[^"]*"|'[^']*'|`[^`]*`/g, ' ')
    .replace(/\S*[\/\\]\S*/g, ' ')
    .replace(/\b[0-9a-f]{7,}\b/g, ' ')
    .replace(/[^a-z]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6);
  return `${stage || 'none'}|${words.join(' ')}`;
}

function median(values) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  const value = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return Math.round(value);
}

// The score: ideas landed in the last 24 hours, the share of ideas that
// landed on their first build, and the median minutes from dropping an idea
// to it landing. The last two look back 7 days so a quiet day still says
// something. Intake refusals are not builds and do not count as tries.
function ideaScore(rows, { now = Date.now() } = {}) {
  const nowMs = typeof now === 'number' ? now : timeMs(now);
  const inLast = (row, ms) => {
    const at = timeMs(row.finished);
    return at !== null && nowMs - at < ms;
  };
  const builds = (rows || []).filter((row) => row.stage !== 'intake');
  const landed24h = builds.filter((row) => row.outcome === 'landed' && inLast(row, DAY_MS)).length;
  const firstById = new Map();
  for (const row of builds) {
    const prior = firstById.get(row.id);
    if (!prior || (timeMs(row.finished) || 0) < (timeMs(prior.finished) || 0)) firstById.set(row.id, row);
  }
  const windowMs = SCORE_WINDOW_DAYS * DAY_MS;
  const firsts = [...firstById.values()].filter((row) => inLast(row, windowMs));
  const firstLanded = firsts.filter((row) => row.outcome === 'landed').length;
  const toLanded = builds
    .filter((row) => row.outcome === 'landed' && inLast(row, windowMs))
    .map((row) => minutesBetween(row.idea_at, row.finished));
  return {
    landed_24h: landed24h,
    first_try_landed: firstLanded,
    first_try_tried: firsts.length,
    first_try_rate: firsts.length ? Math.round((firstLanded / firsts.length) * 100) : null,
    median_minutes_to_landed: median(toLanded),
    window_days: SCORE_WINDOW_DAYS,
    builds: builds.length,
  };
}

function scoreLine(score) {
  if (!score || !score.builds) return 'score: nothing built yet.';
  const parts = [`score: ${score.landed_24h} landed in the last 24h.`];
  if (score.first_try_tried) {
    parts.push(`${score.first_try_landed} of ${score.first_try_tried} landed first try (${score.first_try_rate}%, last ${score.window_days} days).`);
  }
  parts.push(score.median_minutes_to_landed === null
    ? 'no landings yet to time.'
    : `median ${score.median_minutes_to_landed} min from idea to landed.`);
  return parts.join(' ');
}

// The failure that keeps coming back: the latest failed row, when at least
// REPEAT_COUNT failures in the last 24 hours share its stage and cause.
function repeatedFailure(rows, { now = Date.now(), count = REPEAT_COUNT } = {}) {
  const nowMs = typeof now === 'number' ? now : timeMs(now);
  const recent = (rows || []).filter((row) => {
    const at = timeMs(row.finished);
    return row.outcome === 'failed' && at !== null && nowMs - at < DAY_MS;
  });
  if (!recent.length) return null;
  const latest = recent[recent.length - 1];
  const key = causeKey(latest.stage, latest.cause);
  const same = recent.filter((row) => causeKey(row.stage, row.cause) === key);
  if (same.length < count) return null;
  return { key, stage: latest.stage, cause: latest.cause, count: same.length };
}

module.exports = {
  ideaScore,
  readOutcomes,
  recordOutcome,
  repeatedFailure,
  scoreLine,
};
