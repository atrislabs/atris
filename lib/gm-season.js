'use strict';

// GM season: turns task events into a front office board.
// The core is pure (outcomes in, rows out). loadSeason() is the one thin
// loader that touches the task db, member switches, and missions.
//
// Every job a member takes ends one of three ways: landed, dropped (the claim
// was let go), or sent back. Ratings count all three, so a member that lands
// 8 of 28 jobs does not look like a 99 just because autoland keeps the 8.

const fs = require('fs');
const path = require('path');

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const SEASON_DAYS = 30;
const ROOKIE_FINISHED = 3;
const ACTIVE_MISSION_STATUSES = new Set(['running', 'ready']);
const KEPT_ACTIONS = new Set(['accepted', 'merged']);
const FINISHED = new Set(['landed', 'dropped', 'sent_back']);
const FORM_LETTER = { landed: 'k', dropped: 'd', sent_back: 'x' };
const PLAY_WORD = { took: 'took', landed: 'landed', dropped: 'dropped', sent_back: 'sent back' };

// An outcome is one play:
// { event_id, task_id, member, title, kind, at, claimed_at, landed_by }
// kind is took | landed | dropped | sent_back. at and claimed_at are epoch ms;
// claimed_at may be null. landed_by is autoland | you, only on landed.

function byTimeAsc(a, b) {
  return Number(a.at || 0) - Number(b.at || 0);
}

function isFinished(outcome) {
  return Boolean(outcome && FINISHED.has(outcome.kind));
}

function tally(outcomes) {
  const out = { took: 0, landed: 0, dropped: 0, sent_back: 0 };
  for (const o of outcomes || []) {
    if (Object.prototype.hasOwnProperty.call(out, o.kind)) out[o.kind] += 1;
  }
  out.finished = out.landed + out.dropped + out.sent_back;
  // A job claimed before the window can finish inside it, so never show
  // more landed than jobs.
  out.jobs = Math.max(out.took, out.finished);
  return out;
}

// round(60 + 39 * landed / finished), rookie under 3 finished jobs. This is
// stricter than the website rule (kept / graded) on purpose: drops count.
function ovr(outcomes) {
  const { landed, finished } = tally(outcomes);
  if (finished < ROOKIE_FINISHED) return null;
  return Math.round(60 + 39 * landed / finished);
}

// Last n finished jobs, oldest on the left, newest on the right.
function form(outcomes, n = 5) {
  return [...(outcomes || [])]
    .filter(isFinished)
    .sort(byTimeAsc)
    .slice(-n)
    .map(o => FORM_LETTER[o.kind])
    .join('');
}

function outcomeHours(outcome) {
  const at = Number(outcome && outcome.at);
  const claimed = Number(outcome && outcome.claimed_at);
  if (!Number.isFinite(at) || !Number.isFinite(claimed) || !claimed || at < claimed) return null;
  return Math.round(((at - claimed) / HOUR_MS) * 10) / 10;
}

function clipTitle(value, max = 48) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 3)).trim()}...`;
}

// Most recent n finished jobs of any kind, newest first, so drops show too.
function boxScores(outcomes, n = 5) {
  return [...(outcomes || [])]
    .filter(isFinished)
    .sort((a, b) => byTimeAsc(b, a))
    .slice(0, n)
    .map(o => ({
      task_id: o.task_id || null,
      member: o.member,
      title: clipTitle(o.title, 42),
      kind: o.kind,
      outcome: PLAY_WORD[o.kind],
      hours: outcomeHours(o),
      at: o.at,
    }));
}

// Newest n plays of every kind. ids in `seen` are old; the rest are marked new.
function lastPlays(outcomes, n = 5, seen = null) {
  return [...(outcomes || [])]
    .sort((a, b) => byTimeAsc(b, a))
    .slice(0, n)
    .map(o => ({
      id: o.event_id || `${o.task_id}:${o.kind}:${o.at}`,
      member: o.member,
      title: clipTitle(o.title, 34),
      kind: o.kind,
      play: PLAY_WORD[o.kind],
      at: o.at,
      fresh: Boolean(seen && !seen.has(o.event_id || `${o.task_id}:${o.kind}:${o.at}`)),
    }));
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

// "8:04 pm" in local time for today, "oct 15 8:04 pm" for any other day.
function clockLabel(ms, now = Date.now()) {
  const d = new Date(ms);
  if (!Number.isFinite(d.getTime())) return '';
  const h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, '0');
  const time = `${h % 12 || 12}:${m} ${h < 12 ? 'am' : 'pm'}`;
  const today = new Date(now);
  const sameDay = d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate();
  return sameDay ? time : `${MONTHS[d.getMonth()]} ${d.getDate()} ${time}`;
}

// Monday 00:00 local time for the week that contains now.
function weekStart(now = Date.now()) {
  const d = new Date(now);
  const daysSinceMonday = (d.getDay() + 6) % 7;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - daysSinceMonday).getTime();
}

function ownerMood(outcomes, now = Date.now()) {
  const since = weekStart(now);
  const week = (outcomes || []).filter(o => Number(o.at) >= since && Number(o.at) <= Number(now));
  const byAutoland = week.filter(o => o.kind === 'landed' && o.landed_by === 'autoland').length;
  const byYou = week.filter(o => o.kind === 'landed' && o.landed_by !== 'autoland').length;
  const { sent_back: sentBack, dropped } = tally(week);
  return {
    since,
    landed_by_autoland: byAutoland,
    landed_by_you: byYou,
    sent_back: sentBack,
    dropped,
    line: `this week: ${byAutoland} landed by autoland, ${byYou} by you, ${sentBack} sent back, ${dropped} dropped`,
  };
}

function memberStatus(name, { asleep, busy }) {
  if (asleep && asleep.has(name)) return 'asleep';
  if (busy && busy.has(name)) return 'on a job';
  return 'idle';
}

function rosterOrder(a, b) {
  if ((a.ovr == null) !== (b.ovr == null)) return a.ovr == null ? 1 : -1;
  return (b.ovr || 0) - (a.ovr || 0)
    || b.finished - a.finished
    || b.last_at - a.last_at
    || a.name.localeCompare(b.name);
}

// Members by rating, rookies last. Members on a job with no plays yet fill
// any empty slots so the roster shows who is working.
function rosterRows({ outcomes = [], busy = [], asleep = [], limit = 8 } = {}) {
  const busySet = new Set(busy);
  const asleepSet = new Set(asleep);
  const groups = new Map();
  for (const o of outcomes) {
    if (!o.member) continue;
    if (!groups.has(o.member)) groups.set(o.member, []);
    groups.get(o.member).push(o);
  }
  const rows = Array.from(groups.entries()).map(([name, list]) => ({
    name,
    ...tally(list),
    ovr: ovr(list),
    form: form(list),
    status: memberStatus(name, { asleep: asleepSet, busy: busySet }),
    last_at: Math.max(...list.map(o => Number(o.at) || 0)),
  }));
  rows.sort(rosterOrder);
  for (const name of [...busySet].sort()) {
    if (groups.has(name)) continue;
    rows.push({
      name,
      ...tally([]),
      ovr: null,
      form: '',
      status: memberStatus(name, { asleep: asleepSet, busy: busySet }),
      last_at: 0,
    });
  }
  return rows.slice(0, limit);
}

// Open tasks first (oldest first, the queue order), then active missions.
function upNext({ openTasks = [], missions = [] } = {}, n = 3) {
  const tasks = [...openTasks]
    .sort((a, b) => Number(a.created_at || 0) - Number(b.created_at || 0))
    .map(t => ({ kind: 'task', ref: t.ref || null, title: clipTitle(t.title, 56), owner: t.owner || null }));
  const active = missions
    .filter(m => ACTIVE_MISSION_STATUSES.has(m.status))
    .map(m => ({ kind: 'mission', ref: null, title: clipTitle(m.objective || m.slug || m.id, 56), owner: m.owner || null }));
  return [...tasks, ...active].slice(0, n);
}

function parseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function landedBy(row, payload) {
  if (payload && payload.auto_accepted === true) return 'autoland';
  return /auto/i.test(String(row.actor || '')) ? 'autoland' : 'you';
}

// One raw event row to one play, or null when it is not a play.
// claimed and claim_released belong to the actor; landed and sent back
// belong to whoever held the claim then (the last earlier claimed event,
// falling back to tasks.claimed_by). A release goes to the member that held
// the job (previous_claimed_by), then released_by, then the actor, so a
// person clearing a stale claim does not take the drop.
function outcomeFromEvent(row) {
  const payload = parseJson(row.payload) || {};
  const holder = row.claim_actor || row.claimed_by || null;
  let kind = null;
  let member = null;
  if (row.event_type === 'claimed') {
    kind = 'took';
    member = row.actor || payload.claimed_by;
  } else if (row.event_type === 'claim_released') {
    kind = 'dropped';
    member = payload.previous_claimed_by || payload.released_by || row.actor;
  } else if (row.event_type === 'completed' && KEPT_ACTIONS.has(payload.action)) {
    kind = 'landed';
    member = holder;
  } else if (row.event_type === 'revision_requested' || row.event_type === 'reopened') {
    kind = 'sent_back';
    member = holder;
  }
  if (!kind || !member) return null;
  const claimedAt = kind === 'took' ? null : (row.claim_event_at != null ? Number(row.claim_event_at) : (row.claimed_at != null ? Number(row.claimed_at) : null));
  return {
    event_id: row.event_id || null,
    task_id: row.task_id,
    member: String(member),
    title: row.title || '',
    kind,
    at: Number(row.created_at),
    claimed_at: claimedAt,
    landed_by: kind === 'landed' ? landedBy(row, payload) : null,
  };
}

function outcomesFromEvents(rows) {
  return (rows || []).map(outcomeFromEvent).filter(Boolean).sort(byTimeAsc);
}

function emptySeason(workspaceRoot, now) {
  return {
    workspace_root: workspaceRoot,
    workspace_name: path.basename(workspaceRoot),
    now,
    outcomes: [],
    open_tasks: [],
    busy: [],
    asleep: [],
    missions: [],
  };
}

// The one loader: last 30 days of plays for a workspace, plus who is on a
// job, who is asleep, and what is up next. Opens the db read-only.
function loadSeason(workspaceRoot, { now = Date.now(), days = SEASON_DAYS, dbPath } = {}) {
  const season = emptySeason(workspaceRoot, now);
  const { asleepMembers } = require('./member-switches');
  season.asleep = asleepMembers(workspaceRoot);

  try {
    const { listMissions } = require('../commands/mission');
    season.missions = (listMissions(workspaceRoot) || []).map(m => ({
      id: m.id,
      slug: m.slug,
      objective: m.objective,
      owner: m.owner,
      status: m.status,
    }));
  } catch {
    season.missions = [];
  }

  const taskDb = require('./task-db');
  const target = dbPath || taskDb.getDbPath();
  if (!fs.existsSync(target)) return finishSeason(season);

  let db;
  try {
    const { DatabaseSync } = require('node:sqlite');
    db = new DatabaseSync(target, { readOnly: true });
    const since = now - days * DAY_MS;
    const events = db.prepare(`
      SELECT e.event_id, e.task_id, e.event_type, e.actor, e.payload, e.created_at,
             t.title, t.claimed_by, t.claimed_at,
             (SELECT c.created_at FROM task_events c
               WHERE c.task_id = e.task_id AND c.event_type = 'claimed' AND c.created_at <= e.created_at
                 AND c.event_id <> e.event_id
               ORDER BY c.created_at DESC LIMIT 1) AS claim_event_at,
             (SELECT c.actor FROM task_events c
               WHERE c.task_id = e.task_id AND c.event_type = 'claimed' AND c.created_at <= e.created_at
                 AND c.event_id <> e.event_id
               ORDER BY c.created_at DESC LIMIT 1) AS claim_actor
        FROM task_events e
        JOIN tasks t ON t.id = e.task_id
       WHERE e.workspace_root = ?
         AND e.created_at >= ?
         AND e.event_type IN ('claimed', 'claim_released', 'completed', 'revision_requested', 'reopened')
       ORDER BY e.created_at ASC
    `).all(workspaceRoot, since);
    season.outcomes = outcomesFromEvents(events);

    const taskRows = db.prepare(`
      SELECT id, title, status, tag, workspace_root, claimed_by, claimed_at, created_at, updated_at, metadata
        FROM tasks WHERE workspace_root = ?
    `).all(workspaceRoot).map(row => ({ ...row, metadata: parseJson(row.metadata) || {} }));
    const live = taskDb.withTaskDisplayRefs(taskRows).filter(t => ['open', 'claimed', 'review'].includes(t.status));
    season.open_tasks = live
      .filter(t => t.status === 'open')
      .map(t => ({ id: t.id, ref: t.display_id || t.legacy_ref || null, title: t.title, created_at: t.created_at, owner: t.metadata.assigned_to || null }));
    season.busy = [...new Set(live.filter(t => t.status === 'claimed' && t.claimed_by).map(t => String(t.claimed_by)))];
  } catch (err) {
    season.error = err && err.message ? err.message : String(err);
  } finally {
    if (db) {
      try { db.close(); } catch {}
    }
  }
  return finishSeason(season);
}

function finishSeason(season) {
  const runningOwners = season.missions
    .filter(m => m.status === 'running' && m.owner)
    .map(m => String(m.owner));
  season.busy = [...new Set([...season.busy, ...runningOwners])].sort();
  return season;
}

// Everything the board needs, computed from a loaded season. `seen` holds
// play ids from the last draw so new plays can be tagged.
function seasonBoard(season, { limit = 8, seen = null } = {}) {
  return {
    workspace_name: season.workspace_name,
    now: season.now,
    week_of: weekStart(season.now),
    mood: ownerMood(season.outcomes, season.now),
    roster: rosterRows({ outcomes: season.outcomes, busy: season.busy, asleep: season.asleep, limit }),
    box_scores: boxScores(season.outcomes),
    last_plays: lastPlays(season.outcomes, 5, seen),
    up_next: upNext({ openTasks: season.open_tasks, missions: season.missions }),
    error: season.error || null,
  };
}

module.exports = {
  boxScores,
  clockLabel,
  form,
  lastPlays,
  loadSeason,
  outcomesFromEvents,
  ovr,
  ownerMood,
  rosterRows,
  seasonBoard,
  upNext,
  weekStart,
};
