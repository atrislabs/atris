'use strict';

// GM season: turns graded task results into a front office board.
// The core is pure (results in, rows out). loadSeason() is the one thin
// loader that touches the task db, member switches, and missions.

const fs = require('fs');
const path = require('path');

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const SEASON_DAYS = 30;
const ROOKIE_GRADED = 3;
const ACTIVE_MISSION_STATUSES = new Set(['running', 'ready']);
const KEPT_ACTIONS = new Set(['accepted', 'merged']);

// A result is one graded outcome:
// { task_id, member, title, verdict: 'kept' | 'sent_back', at, claimed_at }
// at and claimed_at are epoch ms; claimed_at may be null.

function byTimeAsc(a, b) {
  return Number(a.at || 0) - Number(b.at || 0);
}

function countVerdicts(results) {
  let kept = 0;
  let sentBack = 0;
  for (const r of results || []) {
    if (r.verdict === 'kept') kept += 1;
    else if (r.verdict === 'sent_back') sentBack += 1;
  }
  return { kept, sent_back: sentBack, graded: kept + sentBack };
}

// Matches the website rule: round(60 + 39 * kept / graded), rookie under 3 graded.
function ovr(results) {
  const { kept, graded } = countVerdicts(results);
  if (graded < ROOKIE_GRADED) return null;
  return Math.round(60 + 39 * kept / graded);
}

// Last n results, oldest on the left, newest on the right.
function form(results, n = 5) {
  return [...(results || [])]
    .filter(r => r.verdict === 'kept' || r.verdict === 'sent_back')
    .sort(byTimeAsc)
    .slice(-n)
    .map(r => (r.verdict === 'kept' ? 'k' : 'x'))
    .join('');
}

function resultHours(result) {
  const at = Number(result && result.at);
  const claimed = Number(result && result.claimed_at);
  if (!Number.isFinite(at) || !Number.isFinite(claimed) || !claimed || at < claimed) return null;
  return Math.round(((at - claimed) / HOUR_MS) * 10) / 10;
}

function clipTitle(value, max = 48) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 3)).trim()}...`;
}

// Most recent n graded results, newest first.
function boxScores(results, n = 5) {
  return [...(results || [])]
    .filter(r => r.verdict === 'kept' || r.verdict === 'sent_back')
    .sort((a, b) => byTimeAsc(b, a))
    .slice(0, n)
    .map(r => ({
      task_id: r.task_id || null,
      member: r.member,
      title: clipTitle(r.title, 42),
      verdict: r.verdict,
      outcome: r.verdict === 'kept' ? 'kept' : 'sent back',
      hours: resultHours(r),
      at: r.at,
    }));
}

// Monday 00:00 local time for the week that contains now.
function weekStart(now = Date.now()) {
  const d = new Date(now);
  const daysSinceMonday = (d.getDay() + 6) % 7;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - daysSinceMonday).getTime();
}

function ownerMood(results, now = Date.now()) {
  const since = weekStart(now);
  const week = (results || []).filter(r => Number(r.at) >= since && Number(r.at) <= Number(now));
  const { kept, sent_back: sentBack } = countVerdicts(week);
  return {
    since,
    kept,
    sent_back: sentBack,
    line: `this week: ${kept} kept, ${sentBack} sent back`,
  };
}

function memberStatus(name, { asleep, busy }) {
  if (asleep && asleep.has(name)) return 'asleep';
  if (busy && busy.has(name)) return 'on a job';
  return 'idle';
}

// Top members by graded results in the window. Members on a job with no
// grades yet fill any empty slots so the roster shows who is working.
function rosterRows({ results = [], busy = [], asleep = [], limit = 8 } = {}) {
  const busySet = new Set(busy);
  const asleepSet = new Set(asleep);
  const groups = new Map();
  for (const r of results) {
    if (!r.member) continue;
    if (!groups.has(r.member)) groups.set(r.member, []);
    groups.get(r.member).push(r);
  }
  const rows = Array.from(groups.entries()).map(([name, list]) => {
    const counts = countVerdicts(list);
    return {
      name,
      graded: counts.graded,
      kept: counts.kept,
      sent_back: counts.sent_back,
      ovr: ovr(list),
      form: form(list),
      status: memberStatus(name, { asleep: asleepSet, busy: busySet }),
      last_at: Math.max(...list.map(r => Number(r.at) || 0)),
    };
  });
  rows.sort((a, b) => b.graded - a.graded || b.last_at - a.last_at || a.name.localeCompare(b.name));
  for (const name of [...busySet].sort()) {
    if (groups.has(name)) continue;
    rows.push({
      name,
      graded: 0,
      kept: 0,
      sent_back: 0,
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

function graded(eventType, payload) {
  if (eventType === 'revision_requested') return 'sent_back';
  if (eventType === 'completed' && payload && KEPT_ACTIONS.has(payload.action)) return 'kept';
  return null;
}

function parseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// Build the results list from raw event rows (pure, used by the loader).
function resultsFromEvents(rows) {
  const results = [];
  for (const row of rows || []) {
    const verdict = graded(row.event_type, parseJson(row.payload));
    if (!verdict) continue;
    const member = row.claimed_by || row.claim_actor || null;
    if (!member) continue;
    results.push({
      task_id: row.task_id,
      member: String(member),
      title: row.title || '',
      verdict,
      at: Number(row.created_at),
      claimed_at: row.claim_event_at != null ? Number(row.claim_event_at) : (row.claimed_at != null ? Number(row.claimed_at) : null),
    });
  }
  return results.sort(byTimeAsc);
}

function emptySeason(workspaceRoot, now) {
  return {
    workspace_root: workspaceRoot,
    workspace_name: path.basename(workspaceRoot),
    now,
    results: [],
    open_tasks: [],
    busy: [],
    asleep: [],
    missions: [],
  };
}

// The one loader: last 30 days of graded results for a workspace, plus who is
// on a job, who is asleep, and what is up next. Opens the db read-only.
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
      SELECT e.task_id, e.event_type, e.payload, e.created_at,
             t.title, t.claimed_by, t.claimed_at,
             (SELECT MAX(c.created_at) FROM task_events c
               WHERE c.task_id = e.task_id AND c.event_type = 'claimed' AND c.created_at <= e.created_at) AS claim_event_at,
             (SELECT c.actor FROM task_events c
               WHERE c.task_id = e.task_id AND c.event_type = 'claimed' AND c.created_at <= e.created_at
               ORDER BY c.created_at DESC LIMIT 1) AS claim_actor
        FROM task_events e
        JOIN tasks t ON t.id = e.task_id
       WHERE e.workspace_root = ?
         AND e.created_at >= ?
         AND e.event_type IN ('completed', 'revision_requested')
       ORDER BY e.created_at ASC
    `).all(workspaceRoot, since);
    season.results = resultsFromEvents(events);

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

// Everything the board needs, computed from a loaded season.
function seasonBoard(season, { limit = 8 } = {}) {
  return {
    workspace_name: season.workspace_name,
    week_of: weekStart(season.now),
    mood: ownerMood(season.results, season.now),
    roster: rosterRows({ results: season.results, busy: season.busy, asleep: season.asleep, limit }),
    box_scores: boxScores(season.results),
    up_next: upNext({ openTasks: season.open_tasks, missions: season.missions }),
    error: season.error || null,
  };
}

module.exports = {
  ROOKIE_GRADED,
  SEASON_DAYS,
  boxScores,
  clipTitle,
  form,
  loadSeason,
  ovr,
  ownerMood,
  resultHours,
  resultsFromEvents,
  rosterRows,
  seasonBoard,
  upNext,
  weekStart,
};
