'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_MIN_RECEIPTS = 3;
const DEFAULT_HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000;
const DURATION_SCALE_MS = 60 * 1000;
const STRETCH_ZONE_MIN = 0.6;
const STRETCH_ZONE_MAX = 0.85;

function objectValue(value) {
  return value && typeof value === 'object' ? value : null;
}

function recordContainers(record) {
  const row = objectValue(record);
  if (!row) return [];
  return [
    row,
    objectValue(row.payload),
    objectValue(row.result),
    objectValue(row.tick),
    objectValue(row.result?.tick),
    objectValue(row.payload?.tick),
    objectValue(row.verifier_result),
    objectValue(row.result?.verifier_result),
    objectValue(row.payload?.verifier_result),
    objectValue(row.mission),
    objectValue(row.context),
  ].filter(Boolean);
}

function firstField(containers, names, accept = (value) => value != null) {
  for (const container of containers) {
    for (const name of names) {
      const value = container[name];
      if (accept(value)) return value;
    }
  }
  return null;
}

function normalizedLabel(value) {
  return String(value || '').trim().toLowerCase();
}

function finiteNonnegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function recordDuration(containers) {
  const direct = firstField(
    containers,
    ['duration_ms', 'durationMs', 'elapsed_ms', 'elapsedMs'],
    (value) => finiteNonnegative(value) !== null,
  );
  if (direct !== null) return finiteNonnegative(direct);
  for (const container of containers) {
    const started = Date.parse(String(container.started_at || container.startedAt || ''));
    const finished = Date.parse(String(container.finished_at || container.finishedAt || ''));
    if (Number.isFinite(started) && Number.isFinite(finished) && finished >= started) {
      return finished - started;
    }
  }
  return null;
}

function recordTimestamp(containers, fallbackMs) {
  const raw = firstField(containers, [
    'at',
    'ts',
    'finished_at',
    'finishedAt',
    'created_at',
    'createdAt',
    'updated_at',
    'updatedAt',
    'started_at',
    'startedAt',
  ]);
  const parsed = Date.parse(String(raw || ''));
  if (Number.isFinite(parsed)) return parsed;
  return Number.isFinite(fallbackMs) ? fallbackMs : Date.now();
}

// The id a receipt and a roster run record share for the same attempt: the
// task id (`task`, `task_id`), else the brief id. '' means the record names
// nothing shared, so it can never be deduped against another.
function recordRunRef(containers) {
  const raw = firstField(
    containers,
    ['task_id', 'taskId', 'task', 'brief_id', 'briefId', 'run_id', 'runId'],
    (value) => (typeof value === 'string' && value.trim()) || typeof value === 'number',
  );
  return raw === null ? '' : normalizedLabel(raw);
}

function observationFromRecord(record, source, fallbackMs) {
  const containers = recordContainers(record);
  const engine = normalizedLabel(firstField(containers, [
    'engine_id',
    'engine',
    'selected_engine',
    'executor_engine',
    'runner',
  ]));
  const taskType = normalizedLabel(firstField(containers, [
    'task_type',
    'taskType',
    'job_type',
    'jobType',
    'role',
    'kind',
  ]));
  const passed = firstField(
    containers,
    ['verified_passed', 'verifier_passed', 'passed', 'verified'],
    (value) => typeof value === 'boolean',
  );
  if (!engine || !taskType || typeof passed !== 'boolean') return null;
  return {
    engine,
    task_type: taskType,
    verified_passed: passed,
    duration_ms: recordDuration(containers),
    at_ms: recordTimestamp(containers, fallbackMs),
    source,
    run_ref: recordRunRef(containers),
  };
}

function readTaskReceiptObservations(root) {
  const runsDir = path.join(root, 'atris', 'runs');
  let entries;
  try {
    entries = fs.readdirSync(runsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const observations = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json') || !entry.name.includes('task-')) continue;
    const file = path.join(runsDir, entry.name);
    try {
      const stat = fs.statSync(file);
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      const observation = observationFromRecord(parsed, path.relative(root, file), stat.mtimeMs);
      if (observation) observations.push(observation);
    } catch {}
  }
  return observations;
}

function readMissionEventObservations(root) {
  const file = path.join(root, '.atris', 'state', 'mission_events.jsonl');
  let raw;
  let fallbackMs = Date.now();
  try {
    raw = fs.readFileSync(file, 'utf8');
    fallbackMs = fs.statSync(file).mtimeMs;
  } catch {
    return [];
  }
  const observations = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const observation = observationFromRecord(JSON.parse(line), path.relative(root, file), fallbackMs);
      if (observation) observations.push(observation);
    } catch {}
  }
  return observations;
}

function readDispatchReceiptObservations(root) {
  const runsDir = path.join(root, 'atris', 'runs');
  let entries;
  try {
    entries = fs.readdirSync(runsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const observations = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith('dispatch-') || !entry.name.endsWith('.json')) continue;
    const file = path.join(runsDir, entry.name);
    try {
      const stat = fs.statSync(file);
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      const results = Array.isArray(parsed?.results) ? parsed.results : [];
      for (const [index, row] of results.entries()) {
        if (typeof row?.verified_passed !== 'boolean') continue;
        const source = `${path.relative(root, file)}#results[${index}]`;
        const observation = observationFromRecord(row, source, stat.mtimeMs);
        if (observation) observations.push(observation);
      }
    } catch {}
  }
  return observations;
}

// Roster runs (.atris/state/roster_runs.jsonl) as one more signal, for jobs
// the router ranks because no roster line picks for them. Each run counts as
// one receipt, the same weight and the same 30-day half-life as a task
// receipt: landed is a pass; stalled and failed are a miss. Credit out is
// left out, since engine health already benches that worker. The job name
// maps to the role the router ranks by: build to executor, search to
// navigator, review to validator, and an owner's job by its last word
// ("small build" is build work). No record file means no observations, so
// the ranking is exactly what it was without one.
const ROSTER_RUN_DAYS = 30;
const ROSTER_JOB_ROLES = Object.freeze({ build: 'executor', search: 'navigator', review: 'validator' });

function readRosterRunObservations(root, now) {
  const { readRosterRuns, rosterRunsPath, rotatedRunsPaths } = require('./roster-runs');
  const file = rosterRunsPath(root);
  if (!fs.existsSync(file) && !rotatedRunsPaths(root).length) return [];
  const source = path.relative(root, file);
  return readRosterRuns(root, { days: ROSTER_RUN_DAYS, ...(now !== undefined ? { now } : {}) }).flatMap((run) => {
    if (run.outcome === 'credit out') return [];
    const words = String(run.job || '').trim().toLowerCase().split(/\s+/);
    const role = ROSTER_JOB_ROLES[words[words.length - 1]];
    const atMs = Date.parse(run.at);
    if (!role || !Number.isFinite(atMs)) return [];
    return [{
      engine: normalizedLabel(run.engine),
      task_type: role,
      verified_passed: run.outcome === 'landed',
      duration_ms: Number.isFinite(run.seconds) ? run.seconds * 1000 : null,
      at_ms: atMs,
      source,
      run_ref: normalizedLabel(run.task),
    }];
  });
}

// One landed dispatch writes both a receipt result row and a roster run
// record for the same attempt. The shared id is the task id; the receipt
// stamps the moment the run ended, the run record the moment it started.
// Same engine, same task id, a few minutes apart at either end means one
// run, and the receipt wins because its verified flag is authoritative.
// One receipt cancels at most one run: the closest in time. A retry after a
// landed run is its own attempt and still counts.
const RUN_RECEIPT_WINDOW_MS = 5 * 60 * 1000;

function loadRouterHistory(root = process.cwd(), { now } = {}) {
  const receipts = [
    ...readTaskReceiptObservations(root),
    ...readMissionEventObservations(root),
    ...readDispatchReceiptObservations(root),
  ];
  const runs = readRosterRunObservations(root, now);
  const pairs = [];
  for (const [r, receipt] of receipts.entries()) {
    for (const [n, run] of runs.entries()) {
      if (!run.run_ref || receipt.run_ref !== run.run_ref || receipt.engine !== run.engine) continue;
      const gap = Math.min(
        Math.abs(receipt.at_ms - run.at_ms),
        Number.isFinite(run.duration_ms) ? Math.abs(receipt.at_ms - (run.at_ms + run.duration_ms)) : Infinity,
      );
      if (gap <= RUN_RECEIPT_WINDOW_MS) pairs.push({ r, n, gap });
    }
  }
  pairs.sort((a, b) => a.gap - b.gap || a.n - b.n || a.r - b.r);
  const pairedReceipts = new Set();
  const pairedRuns = new Set();
  for (const { r, n } of pairs) {
    if (pairedReceipts.has(r) || pairedRuns.has(n)) continue;
    pairedReceipts.add(r);
    pairedRuns.add(n);
  }
  return [...receipts, ...runs.filter((run, n) => !pairedRuns.has(n))]
    .map(({ run_ref, ...observation }) => observation);
}

function median(values) {
  const sorted = values
    .map(finiteNonnegative)
    .filter((value) => value !== null)
    .sort((left, right) => left - right);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function historyKey(engine, taskType) {
  return `${normalizedLabel(engine)}\u0000${normalizedLabel(taskType)}`;
}

function computeEngineTaskStats(observations, options = {}) {
  const nowValue = options.now instanceof Date ? options.now.getTime() : Number(options.now ?? Date.now());
  const nowMs = Number.isFinite(nowValue) ? nowValue : Date.now();
  const halfLifeValue = Number(options.halfLifeMs ?? DEFAULT_HALF_LIFE_MS);
  const halfLifeMs = Number.isFinite(halfLifeValue) && halfLifeValue > 0
    ? halfLifeValue
    : DEFAULT_HALF_LIFE_MS;
  const groups = new Map();
  for (const row of Array.isArray(observations) ? observations : []) {
    const engine = normalizedLabel(row?.engine);
    const taskType = normalizedLabel(row?.task_type || row?.taskType);
    if (!engine || !taskType || typeof row?.verified_passed !== 'boolean') continue;
    const key = historyKey(engine, taskType);
    const group = groups.get(key) || { engine, task_type: taskType, receipts: [] };
    group.receipts.push(row);
    groups.set(key, group);
  }

  return [...groups.values()].map((group) => {
    let weightedPasses = 0;
    let totalWeight = 0;
    let verifiedPasses = 0;
    for (const receipt of group.receipts) {
      const atMs = Number(receipt.at_ms);
      const ageMs = Number.isFinite(atMs) ? Math.max(0, nowMs - atMs) : halfLifeMs;
      const weight = Math.pow(0.5, ageMs / halfLifeMs);
      totalWeight += weight;
      if (receipt.verified_passed) {
        verifiedPasses += 1;
        weightedPasses += weight;
      }
    }
    const receiptCount = group.receipts.length;
    const passRate = verifiedPasses / receiptCount;
    const weightedPassRate = totalWeight > 0 ? weightedPasses / totalWeight : passRate;
    const medianDurationMs = median(group.receipts.map((receipt) => receipt.duration_ms));
    const durationScore = medianDurationMs === null
      ? 0
      : 1 / (1 + (medianDurationMs / DURATION_SCALE_MS));
    return {
      engine: group.engine,
      task_type: group.task_type,
      receipt_count: receiptCount,
      verified_passes: verifiedPasses,
      verified_failures: receiptCount - verifiedPasses,
      verified_pass_rate: passRate,
      median_duration_ms: medianDurationMs,
      recency_weighted_score: (weightedPassRate * 0.85) + (durationScore * 0.15),
    };
  }).sort((left, right) => left.engine.localeCompare(right.engine)
    || left.task_type.localeCompare(right.task_type));
}

function candidateId(candidate) {
  return normalizedLabel(typeof candidate === 'string' ? candidate : candidate?.id || candidate?.name);
}

function fallbackOrder(candidate, index) {
  const value = Number(candidate && typeof candidate === 'object' ? candidate.fallback_order : NaN);
  return Number.isFinite(value) ? value : index;
}

function legacyRank(candidates) {
  return candidates
    .map((candidate, index) => ({ candidate, index }))
    .sort((left, right) => fallbackOrder(left.candidate, left.index) - fallbackOrder(right.candidate, right.index)
      || candidateId(left.candidate).localeCompare(candidateId(right.candidate)))
    .map((entry) => entry.candidate);
}

function rankEnginesDetailed(candidates, options = {}) {
  const input = Array.isArray(candidates) ? candidates : [];
  const legacy = legacyRank(input);
  const taskType = normalizedLabel(options.taskType || options.task_type);
  const minValue = Number(options.minReceipts ?? DEFAULT_MIN_RECEIPTS);
  const minReceipts = Number.isInteger(minValue) && minValue > 0 ? minValue : DEFAULT_MIN_RECEIPTS;
  const observations = Array.isArray(options.observations)
    ? options.observations
    : loadRouterHistory(options.root || process.cwd(), { now: options.now });
  const stats = computeEngineTaskStats(observations, options);
  const statsByEngine = new Map(stats
    .filter((row) => row.task_type === taskType)
    .map((row) => [row.engine, row]));
  const thinEngines = legacy
    .map(candidateId)
    .filter((engine) => !statsByEngine.has(engine) || statsByEngine.get(engine).receipt_count < minReceipts);

  if (!taskType || thinEngines.length) {
    return {
      candidates: legacy,
      stats,
      task_type: taskType,
      used_track_record: false,
      thin_engines: thinEngines,
    };
  }

  const ranked = legacy
    .map((candidate, index) => ({ candidate, index, stats: statsByEngine.get(candidateId(candidate)) }))
    .sort((left, right) => right.stats.recency_weighted_score - left.stats.recency_weighted_score
      || fallbackOrder(left.candidate, left.index) - fallbackOrder(right.candidate, right.index)
      || candidateId(left.candidate).localeCompare(candidateId(right.candidate)))
    .map((entry) => entry.candidate);

  const stretchPick = stretchZonePick(ranked.map((candidate) => ({
    candidate,
    predicted: statsByEngine.get(candidateId(candidate))?.verified_pass_rate ?? null,
  })), options);
  const finalRanked = stretchPick
    ? [stretchPick, ...ranked.filter((candidate) => candidate !== stretchPick)]
    : ranked;
  return {
    candidates: finalRanked,
    stats,
    task_type: taskType,
    used_track_record: true,
    thin_engines: [],
    stretch_zone_pick: stretchPick ? candidateId(stretchPick) : null,
  };
}

function engineCost(candidate) {
  const value = Number(candidate && typeof candidate === 'object' ? candidate.cost : NaN);
  return Number.isFinite(value) && value >= 0 ? value : Number.POSITIVE_INFINITY;
}

// stretch zone rule for low-stakes lanes: land the cheapest engine whose
// predicted success rate sits in the learnable band. entries are
// { candidate, predicted } rows where predicted is a 0..1 rate or null.
// returns the winning candidate, or null when nobody is in the band; the
// caller then keeps the normal score order, whose top is the strongest
// engine, which is the escalation path when every engine sits below the
// band floor.
function stretchZonePick(entries, options = {}) {
  const lowStakes = options.lowStakes === true || normalizedLabel(options.stakes) === 'low';
  if (!lowStakes) return null;
  const rows = (Array.isArray(entries) ? entries : [])
    .map((entry, index) => ({
      candidate: entry && typeof entry === 'object' && 'candidate' in entry ? entry.candidate : entry,
      predicted: entry && typeof entry === 'object' ? finiteNonnegative(entry.predicted) : null,
      index,
    }))
    .filter((row) => row.candidate);
  const inBand = rows
    .filter((row) => row.predicted !== null && row.predicted <= 1
      && row.predicted >= STRETCH_ZONE_MIN && row.predicted <= STRETCH_ZONE_MAX)
    .sort((left, right) => engineCost(left.candidate) - engineCost(right.candidate)
      || right.predicted - left.predicted
      || fallbackOrder(left.candidate, left.index) - fallbackOrder(right.candidate, right.index)
      || candidateId(left.candidate).localeCompare(candidateId(right.candidate)));
  return inBand.length ? inBand[0].candidate : null;
}

function rankEngines(candidates, options = {}) {
  return rankEnginesDetailed(candidates, options).candidates;
}

function routerPickExplanation(decision) {
  const winner = decision?.candidates?.[0];
  const engine = candidateId(winner);
  if (!engine) return '';
  const taskType = normalizedLabel(decision.task_type) || 'work';
  if (!decision.used_track_record) {
    return `router picked ${engine} because ${taskType} track records are thin, so fallback order applies.`;
  }
  const stats = decision.stats.find((row) => row.engine === engine && row.task_type === taskType);
  if (decision.stretch_zone_pick === engine) {
    const predicted = stats ? stats.verified_pass_rate.toFixed(2) : 'unknown';
    return `router picked ${engine} because the lane is low stakes and its predicted pass rate ${predicted} sits in the ${STRETCH_ZONE_MIN.toFixed(2)} to ${STRETCH_ZONE_MAX.toFixed(2)} stretch zone at the lowest cost.`;
  }
  if (!stats) return `router picked ${engine} because it has the strongest ${taskType} track record.`;
  const passRate = (stats.verified_pass_rate * 100).toFixed(1);
  const duration = stats.median_duration_ms === null ? 'no duration' : `${Math.round(stats.median_duration_ms)} ms median`;
  return `router picked ${engine} because ${stats.receipt_count} ${taskType} receipts scored ${stats.recency_weighted_score.toFixed(3)} with a ${passRate}% verified pass rate and ${duration}.`;
}

module.exports = {
  STRETCH_ZONE_MIN,
  STRETCH_ZONE_MAX,
  loadRouterHistory,
  computeEngineTaskStats,
  rankEngines,
  rankEnginesDetailed,
  routerPickExplanation,
  stretchZonePick,
};
