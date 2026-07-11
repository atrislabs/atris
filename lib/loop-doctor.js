'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_RECEIPT_LIMIT = 30;
const DEFAULT_FINDING_FRESHNESS_MS = 2 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const AUTH_FAILURES = [
  { key: 'http-401', pattern: /\b401\b/i, label: '401' },
  { key: 'token-expired', pattern: /token expired/i, label: 'Token expired' },
  { key: 'signature-verification-failed', pattern: /signature verification failed/i, label: 'Signature verification failed' },
];
const TERMINAL_MISSION_STATUSES = new Set(['completed', 'complete', 'done', 'stopped', 'cancelled', 'canceled']);
const HEADLESS_CAPABLE_RUNNERS = new Set([
  'auto',
  'claude',
  'atris2',
  'atris-fast',
  'codex',
  'cursor',
  'devin',
  'hermes',
  'hermes-agent',
]);
const FINDING_PRIORITY = {
  repeated_auth_failure: 500,
  repeated_tick_error: 400,
  stale_mission_lock: 350,
  repeated_pause_reason: 300,
  zero_due_capable_missions: 200,
  reward_flatline: 100,
};

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function readJsonl(file) {
  try {
    return fs.readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function timestamp(value) {
  const ms = Date.parse(String(value || ''));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function objectTimestamp(value) {
  if (!value || typeof value !== 'object') return null;
  const fields = ['ts', 'at', 'finished_at', 'updated_at', 'created_at', 'started_at', 'timestamp'];
  for (const field of fields) {
    const parsed = timestamp(value[field]);
    if (parsed) return parsed;
  }
  if (value.result && typeof value.result === 'object') return objectTimestamp(value.result);
  return null;
}

function occurrenceRange(occurrences, fallback = null) {
  const times = occurrences.map((item) => timestamp(item.ts)).filter(Boolean).sort();
  return {
    first_seen: times[0] || fallback,
    last_seen: times[times.length - 1] || fallback,
  };
}

function occurrenceIsFresh(range, nowIso, freshnessMs) {
  if (!range.last_seen) return true;
  const nowMs = Date.parse(nowIso);
  const lastSeenMs = Date.parse(range.last_seen);
  if (!Number.isFinite(nowMs) || !Number.isFinite(lastSeenMs)) return true;
  return nowMs - lastSeenMs <= freshnessMs;
}

function latestMissionRecords(rows) {
  const latest = new Map();
  rows.forEach((row, index) => {
    if (!row || typeof row !== 'object') return;
    const mission = row.mission && typeof row.mission === 'object' ? row.mission : row;
    const id = String(mission.id || row.mission_id || `row-${index}`);
    latest.set(id, mission);
  });
  return [...latest.values()];
}

function loadMissionReceipts(root, limit = DEFAULT_RECEIPT_LIMIT) {
  const runsDir = path.join(root, 'atris', 'runs');
  let names = [];
  try {
    names = fs.readdirSync(runsDir).filter((name) => /^mission-.*\.json$/i.test(name));
  } catch {
    return [];
  }
  return names
    .map((name) => {
      const file = path.join(runsDir, name);
      const receipt = readJson(file);
      return receipt ? { name, file, receipt, ts: objectTimestamp(receipt) } : null;
    })
    .filter(Boolean)
    .sort((a, b) => String(a.ts || a.name).localeCompare(String(b.ts || b.name)))
    .slice(-limit);
}

function walk(value, visit, trail = []) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, visit, [...trail, index]));
    return;
  }
  visit(value, trail);
  Object.entries(value).forEach(([key, child]) => {
    if (child && typeof child === 'object') walk(child, visit, [...trail, key]);
  });
}

function receiptFailureSignals(entry) {
  const signals = [];
  walk(entry.receipt, (value, trail) => {
    if (typeof value.pause_reason === 'string' && value.pause_reason.trim()) {
      signals.push({ type: 'pause_reason', value: value.pause_reason.trim(), trail });
    }
    const status = String(value.status || '').toLowerCase();
    const tickContext = trail.some((part) => part === 'tick' || part === 'ticks');
    const errored = ['error', 'errored', 'failed', 'failure'].includes(status)
      || value.errored === true
      || value.failed === true
      || (tickContext && (value.error != null || value.error_message != null));
    if (!errored) return;
    const detail = value.error || value.error_message || value.reason || value.message || status;
    const text = typeof detail === 'string' ? detail.trim() : JSON.stringify(detail);
    if (text) signals.push({ type: 'tick_error', value: text, trail });
  });
  const unique = new Map();
  for (const signal of signals) unique.set(`${signal.type}\0${signal.value}`, signal);
  return [...unique.values()];
}

function repeatedFailureFindings(receipts, nowIso, freshnessMs) {
  const groups = new Map();
  for (const entry of receipts) {
    for (const signal of receiptFailureSignals(entry)) {
      const key = `${signal.type}\0${signal.value}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ ts: entry.ts, receipt: path.basename(entry.file), trail: signal.trail });
    }
  }

  const byType = new Map();
  for (const [key, occurrences] of groups) {
    if (occurrences.length < 2) continue;
    const range = occurrenceRange(occurrences);
    if (!occurrenceIsFresh(range, nowIso, freshnessMs)) continue;
    const [type, value] = key.split('\0');
    const candidate = { type, value, occurrences, range };
    const current = byType.get(type);
    if (!current || occurrences.length > current.occurrences.length
      || (occurrences.length === current.occurrences.length && value.localeCompare(current.value) < 0)) {
      byType.set(type, candidate);
    }
  }

  return [...byType.values()].map(({ type, value, occurrences, range }) => {
    const kind = type === 'pause_reason' ? 'repeated_pause_reason' : 'repeated_tick_error';
    const label = type === 'pause_reason' ? 'pause reason' : 'tick error';
    return {
      kind,
      evidence: {
        value,
        receipts: occurrences.map((item) => item.receipt),
        detail: `the same ${label} appeared in ${occurrences.length} recent mission receipts`,
      },
      count: occurrences.length,
      ...range,
      suggested_mission: {
        objective: `repair the improve loop's repeated ${label}: ${value}`,
        verifier: `atris improve doctor --check ${kind}`,
        owner: 'auto-improver',
        cadence: '15m',
      },
    };
  });
}

function authFailureFindings(receipts, nowIso, freshnessMs) {
  const matches = AUTH_FAILURES.map((signature) => ({ signature, occurrences: [] }));
  for (const entry of receipts) {
    let text = '';
    try { text = JSON.stringify(entry.receipt); } catch { text = ''; }
    for (const match of matches) {
      if (match.signature.pattern.test(text)) {
        match.occurrences.push({ ts: entry.ts, receipt: path.basename(entry.file) });
      }
    }
  }
  const repeated = matches.filter((match) => {
    if (match.occurrences.length < 2) return false;
    match.range = occurrenceRange(match.occurrences);
    return occurrenceIsFresh(match.range, nowIso, freshnessMs);
  })
    .sort((a, b) => b.occurrences.length - a.occurrences.length || a.signature.key.localeCompare(b.signature.key))[0];
  if (!repeated) return [];
  return [{
    kind: 'repeated_auth_failure',
    evidence: {
      signature: repeated.signature.label,
      receipts: repeated.occurrences.map((item) => item.receipt),
      detail: `${repeated.signature.label} appeared in ${repeated.occurrences.length} recent mission receipts`,
    },
    count: repeated.occurrences.length,
    ...repeated.range,
    suggested_mission: {
      objective: `repair repeated improve-loop authentication failures for ${repeated.signature.label}`,
      verifier: 'atris improve doctor --check repeated_auth_failure',
      owner: 'auto-improver',
      cadence: '15m',
    },
  }];
}

function rewardFlatlineFinding(rows, nowIso) {
  const nowMs = Date.parse(nowIso);
  const since = nowMs - (7 * DAY_MS);
  const recent = rows
    .map((row) => ({ row, ts: objectTimestamp(row), reward: Number(row && row.reward) }))
    .filter((item) => item.ts && Date.parse(item.ts) >= since && Date.parse(item.ts) <= nowMs && Number.isFinite(item.reward));
  if (recent.length < 2 || recent.some((item) => item.reward > 0)) return [];
  const occurrences = recent.map((item) => ({ ts: item.ts }));
  return [{
    kind: 'reward_flatline',
    evidence: {
      rewards: recent.map((item) => item.reward),
      window_days: 7,
      detail: `${recent.length} recent scorecards had no positive reward`,
    },
    count: recent.length,
    ...occurrenceRange(occurrences, nowIso),
    suggested_mission: {
      objective: 'repair the improve loop reward flatline and prove one positive scorecard',
      verifier: 'atris improve doctor --check reward_flatline',
      owner: 'auto-improver',
      cadence: '15m',
    },
  }];
}

function isOpenMission(mission) {
  return mission && !TERMINAL_MISSION_STATUSES.has(String(mission.status || 'planning').toLowerCase());
}

function isDueCapableMission(mission) {
  const cadence = String(mission && mission.cadence || 'manual').trim().toLowerCase();
  const runner = String(mission && mission.runner || 'manual').trim().toLowerCase();
  return isOpenMission(mission)
    && cadence !== 'manual'
    && cadence !== ''
    && mission.always_on === true
    && HEADLESS_CAPABLE_RUNNERS.has(runner);
}

function zeroDueCapableFinding(missions, nowIso) {
  const open = latestMissionRecords(missions).filter(isOpenMission);
  if (open.some(isDueCapableMission)) return [];
  const occurrences = open.map((mission) => ({ ts: objectTimestamp(mission) }));
  return [{
    kind: 'zero_due_capable_missions',
    evidence: {
      open_missions: open.length,
      cadences: [...new Set(open.map((mission) => String(mission.cadence || 'manual')))].sort(),
      runners: [...new Set(open.map((mission) => String(mission.runner || 'manual')))].sort(),
      detail: 'no open mission is always on with a non-manual cadence and a headless-capable runner',
    },
    count: open.length,
    ...occurrenceRange(occurrences, nowIso),
    suggested_mission: {
      objective: 'restore a due-capable headless mission for the improve loop',
      verifier: 'atris improve doctor --check zero_due_capable_missions',
      owner: 'auto-improver',
      cadence: '15m',
    },
  }];
}

function missionLockPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && error.code !== 'ESRCH';
  }
}

function staleMissionLockFinding(root, nowIso, pidAlive = missionLockPidAlive) {
  const stateDir = path.join(root, '.atris', 'state');
  let names = [];
  try {
    names = fs.readdirSync(stateDir).filter((name) => /^mission-.*\.lock$/i.test(name)).sort();
  } catch {
    return [];
  }
  const stale = [];
  for (const name of names) {
    const file = path.join(stateDir, name);
    let lock = null;
    try { lock = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
    const pid = Number(lock && lock.pid);
    if (!Number.isInteger(pid) || pid <= 0) {
      stale.push({ lock: name, reason: 'unparseable', pid: null });
    } else if (!pidAlive(pid)) {
      stale.push({ lock: name, reason: 'dead-pid', pid });
    }
  }
  if (!stale.length) return [];
  return [{
    kind: 'stale_mission_lock',
    evidence: {
      locks: stale,
      detail: `${stale.length} mission lock${stale.length === 1 ? '' : 's'} cannot belong to a live process`,
    },
    count: stale.length,
    first_seen: nowIso,
    last_seen: nowIso,
    suggested_mission: {
      objective: 'clear stale mission locks left by dead runs',
      verifier: 'atris improve doctor --check stale_mission_lock',
      owner: 'auto-improver',
      cadence: '15m',
    },
  }];
}

const REWARD_PRESSURE_WINDOW_MS = DAY_MS;
const REWARD_PRESSURE_PER_ROW = 10;
const REWARD_PRESSURE_CAP = 100;

// Count scorecard rows in the last 24h whose numeric reward is <= 0. This is
// the same recency window shape as rewardFlatlineFinding, just 24h instead
// of 7d: a tighter, more urgent signal for "the loop is bleeding right now."
function nonPositiveRewardPressure(scorecards, nowIso) {
  const nowMs = Date.parse(nowIso);
  const since = nowMs - REWARD_PRESSURE_WINDOW_MS;
  return scorecards
    .map((row) => ({ ts: objectTimestamp(row), reward: Number(row && row.reward) }))
    .filter((item) => item.ts && Date.parse(item.ts) >= since && Date.parse(item.ts) <= nowMs
      && Number.isFinite(item.reward) && item.reward <= 0)
    .length;
}

function applyRewardPressure(findings, rewardPressure) {
  return findings.map((finding) => ({
    ...finding,
    reward_pressure: rewardPressure,
    effective_priority: (FINDING_PRIORITY[finding.kind] || 0) + Math.min(rewardPressure * REWARD_PRESSURE_PER_ROW, REWARD_PRESSURE_CAP),
  }));
}

function orderFindings(findings) {
  return [...findings].sort((a, b) => (b.effective_priority ?? (FINDING_PRIORITY[b.kind] || 0)) - (a.effective_priority ?? (FINDING_PRIORITY[a.kind] || 0))
    || b.count - a.count
    || a.kind.localeCompare(b.kind));
}

function scanLoopReceipts({ root = process.cwd(), now = new Date(), freshnessMs = DEFAULT_FINDING_FRESHNESS_MS } = {}) {
  const parsedNow = new Date(now);
  const nowIso = Number.isFinite(parsedNow.getTime()) ? parsedNow.toISOString() : new Date().toISOString();
  const receipts = loadMissionReceipts(root, DEFAULT_RECEIPT_LIMIT);
  const scorecards = readJsonl(path.join(root, '.atris', 'state', 'scorecards.jsonl'));
  const missions = readJsonl(path.join(root, '.atris', 'state', 'missions.jsonl'));
  const rewardPressure = nonPositiveRewardPressure(scorecards, nowIso);
  const findings = applyRewardPressure([
    ...authFailureFindings(receipts, nowIso, freshnessMs),
    ...repeatedFailureFindings(receipts, nowIso, freshnessMs),
    ...staleMissionLockFinding(root, nowIso),
    ...zeroDueCapableFinding(missions, nowIso),
    ...rewardFlatlineFinding(scorecards, nowIso),
  ], rewardPressure);
  return orderFindings(findings);
}

module.exports = {
  scanLoopReceipts,
  repeatedFailureFindings,
  authFailureFindings,
  rewardFlatlineFinding,
  zeroDueCapableFinding,
  staleMissionLockFinding,
  isDueCapableMission,
  latestMissionRecords,
  orderFindings,
  nonPositiveRewardPressure,
  applyRewardPressure,
  FINDING_PRIORITY,
  DEFAULT_RECEIPT_LIMIT,
  DEFAULT_FINDING_FRESHNESS_MS,
};
