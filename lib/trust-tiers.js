'use strict';

const fs = require('fs');
const path = require('path');

const HISTORY_FILES = [
  path.join('.atris', 'state', 'career_xp_receipts.jsonl'),
  path.join('.atris', 'state', 'scorecards.jsonl'),
];
// Where a legacy history row's builder is recovered from: the row only names
// its task, and these name who built that task.
const EPISODES_FILE = path.join('.atris', 'state', 'task_episodes.jsonl');
const PROJECTION_FILE = path.join('.atris', 'state', 'tasks.projection.json');

const PASS_OUTCOMES = new Set(['accepted', 'approved', 'done', 'pass', 'passed', 'success', 'succeeded']);
const FAIL_OUTCOMES = new Set(['bounced', 'fail', 'failed', 'rejected', 'revised', 'rework_requested']);

function normalizedActor(value) {
  return String(value || '').trim().toLowerCase();
}

// Trust belongs to whoever BUILT the work, never to whoever approved it.
// History rows record `actor` as the approving reviewer (one human on 1,029
// of 1,057 receipts in one busy project), so keying on it, or on fields the
// rows never carried, left every builder at zero history and "still earning
// trust" forever. `actor` is deliberately not read here.
function stampedBuilder(row) {
  return normalizedActor(
    row?.builder
    || row?.built_by
    || row?.claimed_by
    || row?.metadata?.built_by
    || row?.metadata?.executed_by,
  );
}

function rowTaskId(row) {
  return String(row?.source_task_id || row?.task_id || '').trim();
}

function rowPassed(row) {
  for (const value of [row?.passed, row?.verify_passed, row?.metadata?.verify_passed]) {
    if (typeof value === 'boolean') return value;
  }
  for (const value of [row?.outcome, row?.status, row?.rl_label]) {
    const outcome = String(value || '').trim().toLowerCase();
    if (PASS_OUTCOMES.has(outcome)) return true;
    if (FAIL_OUTCOMES.has(outcome)) return false;
  }
  return null;
}

function rowTime(row) {
  for (const value of [row?.accepted_at, row?.ts, row?.recorded_at, row?.created_at, row?.updated_at]) {
    const parsed = Date.parse(value || '');
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function fileStamp(file) {
  try {
    const stat = fs.statSync(file);
    return `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return 'missing';
  }
}

function eachJsonLine(file, fn) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row && typeof row === 'object' && !Array.isArray(row)) fn(row);
    } catch {
      // A torn line in the episode log only costs that one lookup.
    }
  }
}

// task id -> builder, from the episode log (every review snapshot carries the
// task's built_by / claimed_by) and the live projection.
function readTaskBuilders(root) {
  const builders = new Map();
  const remember = (taskId, task) => {
    const id = String(taskId || '').trim();
    const builder = normalizedActor(task?.metadata?.built_by || task?.claimed_by);
    if (id && builder) builders.set(id, builder);
  };
  eachJsonLine(path.join(root, EPISODES_FILE), (episode) => remember(episode.task_id, episode.state));
  try {
    const projection = JSON.parse(fs.readFileSync(path.join(root, PROJECTION_FILE), 'utf8'));
    const tasks = Array.isArray(projection) ? projection : projection?.tasks;
    for (const task of Array.isArray(tasks) ? tasks : []) remember(task?.id, task);
  } catch {
    // No projection: episode builders still apply.
  }
  return builders;
}

function readHistory(root) {
  const rows = [];
  let sequence = 0;
  for (const relative of HISTORY_FILES) {
    let text;
    try {
      text = fs.readFileSync(path.join(root, relative), 'utf8');
    } catch {
      return null;
    }
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        return null;
      }
      if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
      rows.push({ row, sequence: sequence++, time: rowTime(row) });
    }
  }
  return rows;
}

// One outcome per review episode: a receipt and a scorecard written for the
// same episode are the same verdict, not two.
function builderOutcomes(root) {
  const history = readHistory(root);
  if (!history) return null;
  let builders = null;
  const byBuilder = new Map();
  const seenEpisodes = new Set();
  for (const entry of history) {
    const passed = rowPassed(entry.row);
    if (passed === null) continue;
    const episode = String(entry.row.source_episode_id || '').trim();
    if (episode) {
      if (seenEpisodes.has(episode)) continue;
      seenEpisodes.add(episode);
    }
    let builder = stampedBuilder(entry.row);
    if (!builder && rowTaskId(entry.row)) {
      if (!builders) builders = readTaskBuilders(root);
      builder = builders.get(rowTaskId(entry.row)) || '';
    }
    if (!builder) continue;
    if (!byBuilder.has(builder)) byBuilder.set(builder, []);
    byBuilder.get(builder).push({ ...entry, passed });
  }
  return byBuilder;
}

// Called once per waiting task on every status and tick, against a 12 MB
// episode log; memoize per root until one of the files changes.
const outcomeCache = new Map();

function cachedBuilderOutcomes(root) {
  const resolved = path.resolve(root);
  const stamp = [...HISTORY_FILES, EPISODES_FILE, PROJECTION_FILE]
    .map((relative) => fileStamp(path.join(resolved, relative)))
    .join('|');
  const hit = outcomeCache.get(resolved);
  if (hit && hit.stamp === stamp) return hit.value;
  const value = builderOutcomes(resolved);
  outcomeCache.set(resolved, { stamp, value });
  return value;
}

function computeTrustTier(builder, root = process.cwd()) {
  const target = normalizedActor(builder);
  if (!target) return 'probation';
  const byBuilder = cachedBuilderOutcomes(root);
  if (!byBuilder) return 'probation';

  const outcomes = (byBuilder.get(target) || [])
    .slice()
    .sort((a, b) => {
      if (a.time !== null && b.time !== null && a.time !== b.time) return a.time - b.time;
      if (a.time !== null && b.time === null) return 1;
      if (a.time === null && b.time !== null) return -1;
      return a.sequence - b.sequence;
    })
    .slice(-20);

  const passed = outcomes.filter((outcome) => outcome.passed).length;
  const passRate = outcomes.length ? passed / outcomes.length : 0;
  if (outcomes.length >= 10 && passRate >= 0.9) return 'trusted';
  if (outcomes.length >= 5 && passRate >= 0.7) return 'standard';
  return 'probation';
}

// The builder of a task: the stamped builder first, then whoever claimed it.
// Never the approver.
function taskTrustSubject(task) {
  const metadata = task?.metadata || {};
  return normalizedActor(metadata.built_by || task?.claimed_by || metadata.executed_by) || null;
}

module.exports = { computeTrustTier, taskTrustSubject };
