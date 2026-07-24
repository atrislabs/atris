'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DAYS = 7;

function emptyOrbScorecard(days = DEFAULT_DAYS) {
  return {
    days,
    picks: 0,
    dispatches: 0,
    dispatches_by_kind: {},
    dispatches_by_engine: {},
    ok: 0,
    fail: 0,
    orphaned: 0,
    completion_rate: null,
    median_duration_ms: null,
    failures: [],
    orphans: [],
  };
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function readJsonl(file) {
  const rows = [];
  for (const line of readText(file).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const row = JSON.parse(trimmed);
      if (row && typeof row === 'object') rows.push(row);
    } catch {}
  }
  return rows;
}

function sortedCounts(values) {
  const counts = new Map();
  for (const value of values) {
    const key = typeof value === 'string' && value.trim() ? value.trim() : 'unknown';
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return Object.fromEntries([...counts.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

function median(values) {
  const numbers = values.filter((value) => Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  if (!numbers.length) return null;
  const middle = Math.floor(numbers.length / 2);
  return numbers.length % 2 === 1
    ? numbers[middle]
    : (numbers[middle - 1] + numbers[middle]) / 2;
}

function readOrbPicks(root, cutoffDay, today) {
  let picks = 0;
  for (const line of readText(path.join(root, 'now.md')).split(/\r?\n/)) {
    const match = line.match(/^orb:\s+.+\s+·\s+(\d{4}-\d{2}-\d{2})\s*$/);
    if (match && match[1] >= cutoffDay && match[1] <= today) picks += 1;
  }
  return picks;
}

function pidIsAlive(pid) {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) return false;
  try {
    process.kill(numericPid, 0);
    return true;
  } catch {
    return false;
  }
}

function pairOrbRuns(records) {
  const terminalsByLogPath = new Map();
  for (const row of records) {
    if (row.status === 'dispatched') continue;
    const logPath = String(row.logPath || '');
    const terminals = terminalsByLogPath.get(logPath) || [];
    terminals.push(row);
    terminalsByLogPath.set(logPath, terminals);
  }

  const consumedTerminals = new Set();
  const runs = [];
  const orphans = [];
  for (const row of records) {
    if (row.status !== 'dispatched') continue;
    const terminals = terminalsByLogPath.get(String(row.logPath || '')) || [];
    const terminal = terminals.find((candidate) => !consumedTerminals.has(candidate));
    if (terminal) {
      consumedTerminals.add(terminal);
      runs.push({ ...row, ...terminal, status: terminal.status });
      continue;
    }
    const orphaned = !pidIsAlive(row.pid);
    runs.push({ ...row, orphaned });
    if (orphaned) orphans.push({ ...row, orphaned: true });
  }

  for (const row of records) {
    if (row.status !== 'dispatched' && !consumedTerminals.has(row)) runs.push(row);
  }
  return { runs, orphans };
}

function readOrbScorecard(root, { days = DEFAULT_DAYS, now = Date.now() } = {}) {
  const windowDays = Number(days);
  if (!Number.isInteger(windowDays) || windowDays < 1) {
    throw new Error('orb scorecard days must be a positive integer');
  }
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(nowMs)) throw new Error('orb scorecard now must be a valid time');

  const scorecard = emptyOrbScorecard(windowDays);
  const cutoffMs = nowMs - (windowDays * DAY_MS);
  const cutoffDay = new Date(cutoffMs).toISOString().slice(0, 10);
  const today = new Date(nowMs).toISOString().slice(0, 10);
  scorecard.picks = readOrbPicks(root, cutoffDay, today);

  const indexPath = path.join(root, '.atris', 'state', 'orb-runs', 'index.jsonl');
  const records = readJsonl(indexPath).filter((row) => {
    const ts = Date.parse(String(row.ts || ''));
    return Number.isFinite(ts) && ts >= cutoffMs && ts <= nowMs;
  });
  const paired = pairOrbRuns(records);
  const runs = paired.runs;
  const terminalRuns = runs.filter((row) => row.status !== 'dispatched');

  scorecard.dispatches = runs.length;
  scorecard.dispatches_by_kind = sortedCounts(runs.map((row) => row.kind));
  scorecard.dispatches_by_engine = sortedCounts(runs.map((row) => row.engine));
  scorecard.ok = terminalRuns.filter((row) => Number(row.exitCode) === 0).length;
  scorecard.fail = terminalRuns.filter((row) => Number(row.exitCode) !== 0).length + paired.orphans.length;
  scorecard.orphaned = paired.orphans.length;
  const outcomes = scorecard.ok + scorecard.fail;
  scorecard.completion_rate = outcomes ? scorecard.ok / outcomes : null;
  scorecard.median_duration_ms = median(terminalRuns.map((row) => Number(row.durationMs)));
  scorecard.failures = terminalRuns
    .filter((row) => Number(row.exitCode) !== 0)
    .map((row) => ({
      ts: row.ts,
      label: row.label,
      kind: row.kind,
      engine: row.engine,
      exitCode: Number(row.exitCode),
      durationMs: Number(row.durationMs),
      logPath: row.logPath,
      error: row.error || null,
    }));
  scorecard.orphans = paired.orphans.map((row) => ({
    ts: row.ts,
    label: row.label,
    kind: row.kind,
    engine: row.engine,
    logPath: row.logPath,
    pid: Number(row.pid),
    status: row.status,
  }));
  return scorecard;
}

function formatCounts(counts) {
  const entries = Object.entries(counts || {});
  return entries.length ? entries.map(([key, count]) => `${key} ${count}`).join(', ') : 'none';
}

function renderOrbScorecard(scorecard) {
  const rate = scorecard.completion_rate == null
    ? 'n/a'
    : `${(scorecard.completion_rate * 100).toFixed(1)}%`;
  const duration = scorecard.median_duration_ms == null
    ? 'n/a'
    : `${scorecard.median_duration_ms} ms`;
  return [
    `orb scorecard: ${scorecard.days} days`,
    `picks: ${scorecard.picks}`,
    `dispatches: ${scorecard.dispatches}`,
    `by kind: ${formatCounts(scorecard.dispatches_by_kind)}`,
    `by engine: ${formatCounts(scorecard.dispatches_by_engine)}`,
    `outcomes: ${scorecard.ok} ok, ${scorecard.fail} fail`,
    `orphaned: ${scorecard.orphaned}`,
    `completion rate: ${rate}`,
    `median duration: ${duration}`,
  ].join('\n');
}

function parseOrbScorecardDays(args = []) {
  let raw = String(DEFAULT_DAYS);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--days') {
      raw = args[index + 1];
      index += 1;
    } else if (String(arg).startsWith('--days=')) {
      raw = String(arg).slice('--days='.length);
    }
  }
  const days = Number(raw);
  if (!Number.isInteger(days) || days < 1) {
    return { ok: false, error: `invalid --days value: ${raw == null ? '(missing)' : raw}` };
  }
  return { ok: true, days };
}

module.exports = {
  DAY_MS,
  DEFAULT_DAYS,
  readOrbScorecard,
  renderOrbScorecard,
  parseOrbScorecardDays,
};
