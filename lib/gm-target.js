'use strict';

// The owner's weekly target: the game's win condition. Each week the owner
// asks for N landed jobs, at most M abandoned, and at most K claims stuck for
// over a day. A target is saved against the week it was set in and carries
// forward to later weeks until changed or cleared.
//
// Storage: ~/.atris/state/gm-targets/<sha1 of workspace path>.json
//   { workspace, weeks: { "<monday 00:00 ms>": { landed, max_abandoned, max_stuck } | { cleared: true } } }

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
const STUCK_OVER_MS = DAY_MS;
const DEFAULT_MAX_ABANDONED = 2;
const DEFAULT_MAX_STUCK = 0;
const HISTORY_WEEKS = 26;
const CLAIM_ENDS = new Set(['claim_released', 'completed', 'archived', 'reopened']);

// Monday 00:00 local time for the week that contains `at`.
function weekStart(at = Date.now()) {
  const d = new Date(at);
  const daysSinceMonday = (d.getDay() + 6) % 7;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - daysSinceMonday).getTime();
}

// The monday after, found by date so a daylight saving change cannot shift it.
function nextWeekStart(start) {
  return weekStart(Number(start) + 8 * DAY_MS);
}

// ---- storage -----------------------------------------------------------------

function targetsDir() {
  const { atrisHome } = require('./state-home');
  return path.join(atrisHome(), 'state', 'gm-targets');
}

function targetsPath(workspaceRoot, dir) {
  const key = path.resolve(String(workspaceRoot || '.'));
  return path.join(dir, `${crypto.createHash('sha1').update(key).digest('hex')}.json`);
}

function cleanTarget(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.cleared === true) return { cleared: true };
  const landed = Number(raw.landed);
  const maxAbandoned = Number(raw.max_abandoned);
  const maxStuck = Number(raw.max_stuck);
  const whole = n => Number.isInteger(n) && n >= 0;
  if (!whole(landed) || landed < 1 || !whole(maxAbandoned) || !whole(maxStuck)) return null;
  return { landed, max_abandoned: maxAbandoned, max_stuck: maxStuck };
}

// A missing or corrupt file reads as no targets; it never throws.
function readTargets(workspaceRoot, { dir = targetsDir() } = {}) {
  try {
    const raw = JSON.parse(fs.readFileSync(targetsPath(workspaceRoot, dir), 'utf8'));
    const weeks = {};
    for (const [key, value] of Object.entries(raw && raw.weeks && typeof raw.weeks === 'object' ? raw.weeks : {})) {
      const week = Number(key);
      const target = cleanTarget(value);
      if (Number.isFinite(week) && target) weeks[String(week)] = target;
    }
    return { weeks };
  } catch {
    return { weeks: {} };
  }
}

// Saves a target (or { cleared: true }) for the week containing `now`.
// Written to a temp file then renamed. Returns false instead of throwing.
function writeTarget(workspaceRoot, target, { dir = targetsDir(), now = Date.now() } = {}) {
  const clean = cleanTarget(target);
  if (!clean) return false;
  try {
    const store = readTargets(workspaceRoot, { dir });
    store.weeks[String(weekStart(now))] = clean;
    const file = targetsPath(workspaceRoot, dir);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    const body = { workspace: path.resolve(String(workspaceRoot || '.')), weeks: store.weeks };
    fs.writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`);
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

// The target in force for a week: the newest entry at or before that week.
// A cleared entry means no target from then on.
function targetForWeek(store, start) {
  const keys = Object.keys((store && store.weeks) || {}).map(Number).filter(k => k <= Number(start)).sort((a, b) => b - a);
  if (!keys.length) return null;
  const entry = store.weeks[String(keys[0])];
  return entry && !entry.cleared ? entry : null;
}

function firstTargetWeek(store) {
  const keys = Object.keys((store && store.weeks) || {}).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  return keys.length ? keys[0] : null;
}

// ---- scoring -------------------------------------------------------------------

function countKind(outcomes, kind, from, to) {
  return outcomes.filter(o => o.kind === kind && Number(o.at) >= from && Number(o.at) < to).length;
}

// The suggested target: the last 4 full weeks' average landed, rounded up,
// at least 1; at most 2 abandoned; no claim stuck for over a day.
function defaultTarget(outcomes = [], now = Date.now()) {
  const thisWeek = weekStart(now);
  let from = thisWeek;
  for (let i = 0; i < 4; i += 1) from = weekStart(from - DAY_MS);
  const landed = countKind(outcomes, 'landed', from, thisWeek);
  return { landed: Math.max(1, Math.ceil(landed / 4)), max_abandoned: DEFAULT_MAX_ABANDONED, max_stuck: DEFAULT_MAX_STUCK };
}

// won only once the week is over and all three held. During the week a
// broken abandon or stuck limit is already missed; a landed shortfall is
// only behind.
function weekVerdict({ target, landed, abandoned, stuck, over }) {
  const limitsBroken = abandoned > target.max_abandoned || stuck > target.max_stuck;
  if (over) return landed >= target.landed && !limitsBroken ? 'won' : 'missed';
  if (limitsBroken) return 'missed';
  return landed >= target.landed ? 'on track' : 'behind';
}

// Claims held at time `at` whose task had no event for over a day.
// eventsByTask: Map task_id -> [{ event_type, actor, created_at }] by version.
function stuckOverDayAt(eventsByTask, at) {
  let count = 0;
  for (const events of eventsByTask.values()) {
    let holder = null;
    let last = null;
    for (const e of events) {
      if (Number(e.created_at) >= at) break;
      last = Number(e.created_at);
      if (e.event_type === 'claimed') holder = e.actor || 'someone';
      else if (CLAIM_ENDS.has(e.event_type)) holder = null;
    }
    if (holder && last != null && at - last >= STUCK_OVER_MS) count += 1;
  }
  return count;
}

function liveStuckOverDay(claims = [], now = Date.now()) {
  return claims.filter(c => c && c.member && Number(now) - Number(c.last_event_at || 0) >= STUCK_OVER_MS).length;
}

// This week's standing against the target in force, or null with no target.
function currentStatus({ store, outcomes = [], claims = [], now = Date.now() }) {
  const start = weekStart(now);
  const target = targetForWeek(store, start);
  if (!target) return null;
  const landed = countKind(outcomes, 'landed', start, Number(now) + 1);
  const abandoned = countKind(outcomes, 'abandoned', start, Number(now) + 1);
  const stuck = liveStuckOverDay(claims, now);
  return { week_of: start, target, landed, abandoned, stuck, verdict: weekVerdict({ target, landed, abandoned, stuck, over: false }) };
}

// Completed weeks that had a target, each scored with the target in force
// that week and the claims stuck over a day at the moment the week ended.
function seasonRecord({ store, outcomes = [], eventsByTask = new Map(), now = Date.now() }) {
  const first = firstTargetWeek(store);
  const thisWeek = weekStart(now);
  const weeks = [];
  if (first != null) {
    let start = Math.max(first, thisWeek - HISTORY_WEEKS * WEEK_MS);
    start = weekStart(start + DAY_MS);
    while (start < thisWeek) {
      const end = nextWeekStart(start);
      const target = targetForWeek(store, start);
      if (target) {
        const landed = countKind(outcomes, 'landed', start, end);
        const abandoned = countKind(outcomes, 'abandoned', start, end);
        const stuck = stuckOverDayAt(eventsByTask, end);
        weeks.push({ week_of: start, target, landed, abandoned, stuck, verdict: weekVerdict({ target, landed, abandoned, stuck, over: true }) });
      }
      start = end;
    }
  }
  const won = weeks.filter(w => w.verdict === 'won').length;
  return { won, lost: weeks.length - won, weeks };
}

function targetLine(status) {
  if (!status) return null;
  const t = status.target;
  return `target: ${status.landed} of ${t.landed} landed | abandoned ${status.abandoned} of max ${t.max_abandoned} | stuck over a day ${status.stuck}, max ${t.max_stuck} (${status.verdict})`;
}

function recordLine(record) {
  return `season: ${record.won} won, ${record.lost} lost`;
}

// ---- loading -------------------------------------------------------------------

// The oldest moment the target views need plays from: four weeks before this
// week for the default, or the first target week for the record.
function historyStart(store, now = Date.now()) {
  let from = weekStart(now);
  for (let i = 0; i < 4; i += 1) from = weekStart(from - DAY_MS);
  const first = firstTargetWeek(store);
  const floor = weekStart(now) - HISTORY_WEEKS * WEEK_MS;
  return Math.max(floor, Math.min(from, first == null ? from : first));
}

// Task events needed to know who held what at each week's end: every task in
// the workspace that moved since `since` or is claimed now, with its whole
// history. Uses an already open read-only db handle.
function loadClaimHistory(db, workspaceRoot, since) {
  const rows = db.prepare(`
    SELECT e.task_id, e.event_type, e.actor, e.created_at, e.version
      FROM task_events e
     WHERE e.task_id IN (
             SELECT DISTINCT task_id FROM task_events WHERE workspace_root = ? AND created_at >= ?
             UNION
             SELECT id FROM tasks WHERE workspace_root = ? AND status = 'claimed')
     ORDER BY e.task_id, e.version
  `).all(workspaceRoot, since, workspaceRoot);
  const byTask = new Map();
  for (const row of rows) {
    if (!byTask.has(row.task_id)) byTask.set(row.task_id, []);
    byTask.get(row.task_id).push(row);
  }
  return byTask;
}

module.exports = {
  currentStatus,
  defaultTarget,
  historyStart,
  loadClaimHistory,
  readTargets,
  recordLine,
  seasonRecord,
  stuckOverDayAt,
  targetForWeek,
  targetLine,
  weekVerdict,
  writeTarget,
};
