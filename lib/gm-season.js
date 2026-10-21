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
const STALE_MS = 6 * HOUR_MS;
const LAST_SEEN_REL = path.join('.atris', 'state', 'gm-last-seen.json');
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

function episodeKey(o) {
  return o.claim_id || o.event_id || `${o.task_id}:${o.kind}:${o.at}`;
}

// jobs = distinct claim episodes seen in the window (a took, a finish of a
// claim made before the window, or a still-open claim), never below landed.
function tally(outcomes, openClaims = []) {
  const out = { took: 0, landed: 0, dropped: 0, sent_back: 0 };
  const episodes = new Set();
  for (const o of outcomes || []) {
    if (!Object.prototype.hasOwnProperty.call(out, o.kind)) continue;
    out[o.kind] += 1;
    episodes.add(episodeKey(o));
  }
  for (const c of openClaims || []) episodes.add(c.claim_id || `${c.task_id}:claim`);
  out.finished = out.landed + out.dropped + out.sent_back;
  out.jobs = Math.max(episodes.size, out.landed);
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

// Newest n plays of every kind, newest first. Finished plays carry the hours
// from claim to result. ids in `seen` are old; the rest are marked new.
function lastPlays(outcomes, n = 5, seen = null) {
  return [...(outcomes || [])]
    .sort((a, b) => byTimeAsc(b, a))
    .slice(0, n)
    .map((o) => {
      const id = o.event_id || `${o.task_id}:${o.kind}:${o.at}`;
      return {
        id,
        task_id: o.task_id || null,
        member: o.member,
        title: clipTitle(o.title, 30),
        kind: o.kind,
        play: PLAY_WORD[o.kind],
        hours: isFinished(o) ? outcomeHours(o) : null,
        at: o.at,
        fresh: Boolean(seen && !seen.has(id)),
      };
    });
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

function ownerMood(outcomes, now = Date.now(), stuck = 0) {
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
    stuck,
    line: `this week: ${byAutoland} landed by autoland, ${byYou} by you, ${sentBack} sent back, ${dropped} dropped, ${stuck} stuck`,
  };
}

// "7h" under a day, "2d" after.
function ageLabel(ms) {
  const hours = Math.max(0, Number(ms) || 0) / HOUR_MS;
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))}m`;
  if (hours < 24) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}

// A claim is { task_id, ref, title, member, last_event_at }. It is live when
// its task had any event in the last 6 hours, stuck otherwise.
function claimStates(claims = [], now = Date.now(), staleMs = STALE_MS) {
  return claims
    .filter(c => c && c.member)
    .map((c) => {
      const age = Math.max(0, Number(now) - Number(c.last_event_at || 0));
      return { ...c, age_ms: age, age: ageLabel(age), stuck: age >= staleMs };
    });
}

// Stuck claims, oldest first, so the jammed belt is at the top.
function stuckRows(claims = [], now = Date.now(), n = 5) {
  return claimStates(claims, now)
    .filter(c => c.stuck)
    .sort((a, b) => b.age_ms - a.age_ms)
    .slice(0, n)
    .map(c => ({ task_id: c.task_id, ref: c.ref || c.task_id, title: clipTitle(c.title, 40), member: c.member, age: c.age }));
}

// Running missions count as a job only while they moved in the last 6 hours.
function liveMissionOwners(missions = [], now = Date.now(), staleMs = STALE_MS) {
  return missions
    .filter(m => m.status === 'running' && m.owner && Number(now) - Number(m.last_at || 0) < staleMs)
    .map(m => String(m.owner));
}

function statusByMember({ claims = [], missions = [], asleep = [], now = Date.now() } = {}) {
  const asleepSet = new Set(asleep);
  const live = new Set(liveMissionOwners(missions, now));
  const stuckAge = new Map();
  for (const c of claimStates(claims, now)) {
    if (!c.stuck) live.add(c.member);
    else if (!stuckAge.has(c.member) || c.age_ms < stuckAge.get(c.member).age_ms) stuckAge.set(c.member, c);
  }
  return (name) => {
    if (asleepSet.has(name)) return 'asleep';
    if (live.has(name)) return 'on a job';
    if (stuckAge.has(name)) return `stuck ${stuckAge.get(name).age}`;
    return 'idle';
  };
}

// What happened between the last interactive look and now.
function sinceLastLook(outcomes = [], lastSeen = null, now = Date.now()) {
  const seenAt = Number(lastSeen);
  if (!Number.isFinite(seenAt) || seenAt <= 0) return null;
  const after = outcomes.filter(o => Number(o.at) > seenAt && Number(o.at) <= Number(now));
  const { landed, dropped, sent_back: sentBack } = tally(after);
  const ago = ageLabel(Number(now) - seenAt);
  const line = landed + dropped + sentBack === 0
    ? `nothing happened since you looked ${ago} ago`
    : `since you looked (${ago} ago): ${landed} landed, ${dropped} dropped, ${sentBack} sent back`;
  return { last_seen_at: seenAt, landed, dropped, sent_back: sentBack, line };
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
function rosterRows({ outcomes = [], claims = [], missions = [], asleep = [], now = Date.now(), limit = 8 } = {}) {
  const statusOf = statusByMember({ claims, missions, asleep, now });
  const holders = new Set([...claims.map(c => c.member), ...liveMissionOwners(missions, now)].filter(Boolean));
  const claimsOf = name => claims.filter(c => c.member === name);
  const groups = new Map();
  for (const o of outcomes) {
    if (!o.member) continue;
    if (!groups.has(o.member)) groups.set(o.member, []);
    groups.get(o.member).push(o);
  }
  const rows = Array.from(groups.entries()).map(([name, list]) => ({
    name,
    ...tally(list, claimsOf(name)),
    ovr: ovr(list),
    form: form(list),
    status: statusOf(name),
    last_at: Math.max(...list.map(o => Number(o.at) || 0)),
  }));
  rows.sort(rosterOrder);
  for (const name of [...holders].sort()) {
    if (groups.has(name)) continue;
    rows.push({
      name,
      ...tally([], claimsOf(name)),
      ovr: null,
      form: '',
      status: statusOf(name),
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
  // One claim episode per job: a took is its own claim; anything else
  // belongs to the claim before it, or to a claim older than the history.
  const claimId = kind === 'took'
    ? (row.event_id || `${row.task_id}:${row.created_at}`)
    : (row.claim_event_id || `${row.task_id}:before`);
  return {
    event_id: row.event_id || null,
    claim_id: claimId,
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
    claims: [],
    asleep: [],
    missions: [],
    last_seen_at: null,
  };
}

function lastSeenPath(workspaceRoot) {
  return path.join(workspaceRoot, LAST_SEEN_REL);
}

function readLastSeen(workspaceRoot) {
  try {
    const raw = JSON.parse(fs.readFileSync(lastSeenPath(workspaceRoot), 'utf8'));
    const at = Number(raw && raw.last_seen_at);
    return Number.isFinite(at) && at > 0 ? at : null;
  } catch {
    return null;
  }
}

// Only the interactive board writes this; --board and --json only read it.
function writeLastSeen(workspaceRoot, at = Date.now()) {
  const file = lastSeenPath(workspaceRoot);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify({ last_seen_at: at, last_seen_iso: new Date(at).toISOString() })}\n`);
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

function missionLastAt(mission) {
  for (const value of [mission.last_tick_at, mission.updated_at, mission.created_at]) {
    const ms = typeof value === 'number' ? value : Date.parse(value || '');
    if (Number.isFinite(ms)) return ms;
  }
  return 0;
}

// Play events since a time, each with the claim before it. The claim is found
// by per-task version, so two events in the same millisecond still find the
// right holder. `extraWhere` narrows it (one workspace, or none for the league).
function playEventsSql(extraWhere = '') {
  return `
    SELECT e.event_id, e.task_id, e.workspace_root, e.event_type, e.actor, e.payload, e.created_at,
           t.title, t.claimed_by, t.claimed_at,
           c.event_id AS claim_event_id, c.created_at AS claim_event_at, c.actor AS claim_actor
      FROM task_events e
      JOIN tasks t ON t.id = e.task_id
      LEFT JOIN task_events c ON c.event_id = (
        SELECT p.event_id FROM task_events p
         WHERE p.task_id = e.task_id AND p.event_type = 'claimed' AND p.version < e.version
         ORDER BY p.version DESC LIMIT 1)
     WHERE e.created_at >= ?
       AND e.event_type IN ('claimed', 'claim_released', 'completed', 'revision_requested', 'reopened')
       ${extraWhere}
     ORDER BY e.created_at ASC`;
}

// The one loader: last 30 days of plays for a workspace, plus open claims,
// who is asleep, and what is up next. Opens the db read-only.
function loadSeason(workspaceRoot, { now = Date.now(), days = SEASON_DAYS, dbPath } = {}) {
  const season = emptySeason(workspaceRoot, now);
  const { asleepMembers } = require('./member-switches');
  season.asleep = asleepMembers(workspaceRoot);
  season.last_seen_at = readLastSeen(workspaceRoot);

  try {
    const { listMissions } = require('../commands/mission');
    season.missions = (listMissions(workspaceRoot) || []).map(m => ({
      id: m.id,
      slug: m.slug,
      objective: m.objective,
      owner: m.owner,
      status: m.status,
      last_at: missionLastAt(m),
    }));
  } catch {
    season.missions = [];
  }

  const taskDb = require('./task-db');
  const target = dbPath || taskDb.getDbPath();
  if (!fs.existsSync(target)) return season;

  let db;
  try {
    const { DatabaseSync } = require('node:sqlite');
    db = new DatabaseSync(target, { readOnly: true });
    const since = now - days * DAY_MS;
    const events = db.prepare(playEventsSql('AND e.workspace_root = ?')).all(since, workspaceRoot);
    season.outcomes = outcomesFromEvents(events);

    const taskRows = db.prepare(`
      SELECT id, title, status, tag, workspace_root, claimed_by, claimed_at, created_at, updated_at, metadata,
             (SELECT MAX(e.created_at) FROM task_events e WHERE e.task_id = tasks.id) AS last_event_at,
             (SELECT e.event_id FROM task_events e WHERE e.task_id = tasks.id AND e.event_type = 'claimed'
               ORDER BY e.version DESC LIMIT 1) AS claim_event_id
        FROM tasks WHERE workspace_root = ?
    `).all(workspaceRoot).map(row => ({ ...row, metadata: parseJson(row.metadata) || {} }));
    const live = taskDb.withTaskDisplayRefs(taskRows).filter(t => ['open', 'claimed', 'review'].includes(t.status));
    const refOf = t => t.display_id || t.legacy_ref || null;
    season.open_tasks = live
      .filter(t => t.status === 'open')
      .map(t => ({ id: t.id, ref: refOf(t), title: t.title, created_at: t.created_at, owner: t.metadata.assigned_to || null }));
    season.claims = live
      .filter(t => t.status === 'claimed' && t.claimed_by)
      .map(t => ({
        task_id: t.id,
        ref: refOf(t),
        title: t.title,
        member: String(t.claimed_by),
        claim_id: t.claim_event_id || `${t.id}:claim`,
        last_event_at: Number(t.last_event_at || t.claimed_at || t.updated_at || 0),
      }));
  } catch (err) {
    season.error = err && err.message ? err.message : String(err);
  } finally {
    if (db) {
      try { db.close(); } catch {}
    }
  }
  return season;
}

// Everything the board needs, computed from a loaded season. `seen` holds
// play ids from the last draw so new plays can be tagged. `lastSeen`
// overrides the stored last look (the interactive board pins it per session).
function seasonBoard(season, { limit = 8, seen = null, lastSeen } = {}) {
  const stuckAll = claimStates(season.claims, season.now).filter(c => c.stuck);
  return {
    workspace_name: season.workspace_name,
    now: season.now,
    week_of: weekStart(season.now),
    mood: ownerMood(season.outcomes, season.now, stuckAll.length),
    since_last_look: sinceLastLook(season.outcomes, lastSeen === undefined ? season.last_seen_at : lastSeen, season.now),
    roster: rosterRows({
      outcomes: season.outcomes,
      claims: season.claims,
      missions: season.missions,
      asleep: season.asleep,
      now: season.now,
      limit,
    }),
    stuck: stuckRows(season.claims, season.now),
    last_plays: lastPlays(season.outcomes, 5, seen),
    up_next: upNext({ openTasks: season.open_tasks, missions: season.missions }),
    error: season.error || null,
  };
}

// ---- league: every real project folder is a club ---------------------------

const WORKTREE_SEGMENT = /\/\.(agent-worktrees|worktrees)\/|\/\.claude\/worktrees\//;

// A club is a real project folder: not a scratch run under /tmp or the system
// temp dir (the shared scratch helper decides that), and not an agent's
// throwaway worktree checkout.
function isClubRoot(root) {
  const text = String(root || '').replace(/\\/g, '/');
  if (!text.startsWith('/')) return false;
  if (WORKTREE_SEGMENT.test(`${text}/`)) return false;
  const { isUnderGenericScratchRoot } = require('./scratch-root');
  return !isUnderGenericScratchRoot(text);
}

// Club names are folder names; two folders with the same name get their
// parent folder in front so the league stays readable.
function clubNames(roots) {
  const counts = new Map();
  for (const root of roots) {
    const base = path.basename(root);
    counts.set(base, (counts.get(base) || 0) + 1);
  }
  return new Map(roots.map((root) => {
    const base = path.basename(root);
    return [root, counts.get(base) > 1 ? `${path.basename(path.dirname(root))}/${base}` : base];
  }));
}

function leagueOrder(a, b) {
  return b.landed_week - a.landed_week
    || ((a.ovr == null) - (b.ovr == null))
    || (b.ovr || 0) - (a.ovr || 0)
    || b.landed_30d - a.landed_30d
    || (b.last_play_at || 0) - (a.last_play_at || 0)
    || a.club.localeCompare(b.club);
}

// One row per club. clubs: [{ root, outcomes, claims, last_event_at }].
function leagueRows(clubs = [], now = Date.now()) {
  const since = weekStart(now);
  const names = clubNames(clubs.map(c => c.root));
  return clubs.map((club) => {
    const outcomes = club.outcomes || [];
    const counts = tally(outcomes);
    const best = rosterRows({ outcomes, limit: 50 }).find(row => row.ovr != null) || null;
    // Last move on any task, not only plays: a club whose members only post
    // notes and proofs is still awake, and a quiet one should look quiet.
    const lastPlayAt = outcomes.length ? Math.max(...outcomes.map(o => Number(o.at) || 0)) : 0;
    const lastAt = Math.max(lastPlayAt, Number(club.last_event_at) || 0);
    return {
      club: names.get(club.root),
      root: club.root,
      ovr: ovr(outcomes),
      landed_week: outcomes.filter(o => o.kind === 'landed' && Number(o.at) >= since).length,
      landed_30d: counts.landed,
      dropped_30d: counts.dropped,
      stuck: claimStates(club.claims || [], now).filter(c => c.stuck).length,
      last_play_at: lastAt || null,
      last_play: lastAt ? ageLabel(now - lastAt) : '-',
      best_player: best ? { name: best.name, ovr: best.ovr } : null,
    };
  }).sort(leagueOrder);
}

// Reads every workspace's plays for the window in one pass, read-only.
function loadLeague({ now = Date.now(), days = SEASON_DAYS, dbPath } = {}) {
  const league = { now, clubs: [], error: null };
  const taskDb = require('./task-db');
  const target = dbPath || taskDb.getDbPath();
  if (!fs.existsSync(target)) return league;
  let db;
  try {
    const { DatabaseSync } = require('node:sqlite');
    db = new DatabaseSync(target, { readOnly: true });
    const since = now - days * DAY_MS;
    const active = db.prepare(`
      SELECT workspace_root AS root, MAX(created_at) AS last_event_at
        FROM task_events WHERE created_at >= ? GROUP BY workspace_root
    `).all(since).filter(row => isClubRoot(row.root) && fs.existsSync(row.root));
    const byRoot = new Map(active.map(row => [row.root, { root: row.root, last_event_at: Number(row.last_event_at), events: [], claims: [] }]));
    for (const row of db.prepare(playEventsSql()).all(since)) {
      const club = byRoot.get(row.workspace_root);
      if (club) club.events.push(row);
    }
    const claimed = db.prepare(`
      SELECT id, workspace_root, claimed_by, claimed_at, updated_at,
             (SELECT MAX(e.created_at) FROM task_events e WHERE e.task_id = tasks.id) AS last_event_at
        FROM tasks WHERE status = 'claimed' AND claimed_by IS NOT NULL
    `).all();
    for (const t of claimed) {
      const club = byRoot.get(t.workspace_root);
      if (!club) continue;
      club.claims.push({ task_id: t.id, member: String(t.claimed_by), last_event_at: Number(t.last_event_at || t.claimed_at || t.updated_at || 0) });
    }
    league.clubs = [...byRoot.values()].map(club => ({
      root: club.root,
      last_event_at: club.last_event_at,
      outcomes: outcomesFromEvents(club.events),
      claims: club.claims,
    }));
  } catch (err) {
    league.error = err && err.message ? err.message : String(err);
  } finally {
    if (db) {
      try { db.close(); } catch {}
    }
  }
  return league;
}

function leagueBoard(league) {
  return {
    now: league.now,
    days: SEASON_DAYS,
    rows: leagueRows(league.clubs, league.now),
    error: league.error || null,
  };
}

module.exports = {
  ageLabel,
  isClubRoot,
  leagueBoard,
  leagueRows,
  loadLeague,
  clockLabel,
  form,
  lastPlays,
  loadSeason,
  outcomesFromEvents,
  ovr,
  ownerMood,
  readLastSeen,
  rosterRows,
  seasonBoard,
  sinceLastLook,
  stuckRows,
  upNext,
  weekStart,
  writeLastSeen,
};
