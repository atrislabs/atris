'use strict';

// atris check: the time budget.
//
// Every plan says how long each check should take and the total, against the
// tier's target (low 5s, normal 20s, high 300s unless the map's "budget" says
// otherwise). Every run records what each check really took in
// .atris/cache/check-durations.json (capped), and the next estimate is the
// rolling median of the last runs. When a run takes longer than its target,
// the receipt says which check blew it, so slow checks get fixed or moved to
// the lane.

const fs = require('fs');
const path = require('path');

const DURATIONS_FILE = path.join('.atris', 'cache', 'check-durations.json');
const DURATIONS_VERSION = 1;
const SAMPLES = 9;
const MAX_KEYS = 2000;
const MAX_BYTES = 512 * 1024;
// A selected-tests run with no history: this many seconds to start, then this
// many per test, spread over its workers.
const DEFAULT_STARTUP = 2;
const DEFAULT_PER_TEST = 1;

function median(values) {
  const list = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!list.length) return null;
  const mid = Math.floor(list.length / 2);
  return list.length % 2 ? list[mid] : (list[mid - 1] + list[mid]) / 2;
}

function percentile(values, p) {
  const list = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!list.length) return null;
  return list[Math.min(list.length - 1, Math.ceil((p / 100) * list.length) - 1)];
}

function loadDurations(root) {
  try {
    const file = path.join(root, DURATIONS_FILE);
    if (fs.statSync(file).size > MAX_BYTES) return {};
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data && data.version === DURATIONS_VERSION && data.checks ? data.checks : {};
  } catch {
    return {};
  }
}

// rows: [{ key, seconds, count }] for checks that really ran.
function recordDurations(root, rows, { now = Date.now() } = {}) {
  if (!rows.length) return;
  const checks = loadDurations(root);
  for (const row of rows) {
    if (!Number.isFinite(row.seconds)) continue;
    const entry = checks[row.key] || { s: [], n: [] };
    entry.s = [...entry.s, Math.round(row.seconds * 10) / 10].slice(-SAMPLES);
    entry.n = [...(entry.n || []), row.count || 0].slice(-SAMPLES);
    entry.at = now;
    checks[row.key] = entry;
  }
  const kept = Object.entries(checks).sort((a, b) => (b[1].at || 0) - (a[1].at || 0)).slice(0, MAX_KEYS);
  try {
    const dir = path.join(root, path.dirname(DURATIONS_FILE));
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(path.join(dir, '.gitignore'))) fs.writeFileSync(path.join(dir, '.gitignore'), '*\n');
    let text = JSON.stringify({ version: DURATIONS_VERSION, checks: Object.fromEntries(kept) });
    if (Buffer.byteLength(text) > MAX_BYTES) text = JSON.stringify({ version: DURATIONS_VERSION, checks: Object.fromEntries(kept.slice(0, Math.floor(kept.length / 2))) });
    fs.writeFileSync(path.join(root, DURATIONS_FILE), text);
  } catch {}
}

// Expected seconds for one plan entry, and where the number came from.
function estimate(entry, history = {}) {
  const past = history[entry.key];
  if (entry.selectedCount) {
    const startup = entry.seconds || DEFAULT_STARTUP;
    const workers = Math.max(1, entry.workers || 1);
    let perTest = entry.perTestSeconds || DEFAULT_PER_TEST;
    let source = entry.seconds || entry.perTestSeconds ? 'map' : 'default';
    if (past && past.s.length) {
      const rates = past.s.map((seconds, i) => Math.max(0, seconds - startup) / Math.max(1, past.n[i] || 1));
      perTest = median(rates);
      source = 'measured';
    }
    return { seconds: Math.round((startup + (perTest * entry.selectedCount) / workers) * 10) / 10, source };
  }
  if (past && past.s.length) return { seconds: median(past.s), source: 'measured' };
  if (entry.seconds) return { seconds: entry.seconds, source: 'map' };
  return { seconds: null, source: 'unknown' };
}

// The whole plan: each stage runs its checks in a pool of `parallel`, and
// stages run one after another. A stage takes about the longer of its slowest
// check and its total divided by the pool.
function planSeconds(entries, parallel) {
  const byStage = new Map();
  for (const entry of entries) {
    const stage = entry.stage ?? 1;
    if (!byStage.has(stage)) byStage.set(stage, []);
    byStage.get(stage).push(entry.expected || 0);
  }
  let total = 0;
  for (const list of byStage.values()) {
    const sum = list.reduce((a, b) => a + b, 0);
    total += Math.max(Math.max(0, ...list), sum / Math.max(1, parallel));
  }
  return Math.round(total * 10) / 10;
}

// Which check blew the budget, if the run went over it.
function overBudget(target, actualSeconds, rows) {
  if (!target || !(actualSeconds > target)) return null;
  const ran = rows.filter((row) => Number.isFinite(row.seconds) && row.seconds > 0).sort((a, b) => b.seconds - a.seconds);
  const worst = ran[0] || null;
  return {
    target_seconds: target,
    actual_seconds: Math.round(actualSeconds * 10) / 10,
    check: worst ? worst.name : null,
    check_seconds: worst ? worst.seconds : null,
  };
}

module.exports = {
  median,
  percentile,
  loadDurations,
  recordDurations,
  estimate,
  planSeconds,
  overBudget,
};
