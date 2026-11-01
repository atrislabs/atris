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
const { atrisRating } = require('./atris-rating');
const { isProofNotSaved, isCouldNotStart } = require('./release-kind');

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const SEASON_DAYS = 30;
const ROOKIE_FINISHED = 3;
const STALE_MS = 6 * HOUR_MS;
const ACTIVE_MISSION_STATUSES = new Set(['running', 'ready']);
const KEPT_ACTIONS = new Set(['accepted', 'merged']);
const FINISHED = new Set(['landed', 'dropped', 'sent_back', 'abandoned']);
const FORM_LETTER = { landed: 'k', dropped: 'd', sent_back: 'x', abandoned: 'a' };
const PLAY_WORD = { took: 'took', landed: 'landed', dropped: 'dropped', sent_back: 'sent back', abandoned: 'abandoned', not_needed: 'not needed', held: 'held', could_not_start: 'unstarted' };
// A person has this long after a drop to say the job did not need doing.
const NOT_NEEDED_WINDOW_MS = 7 * DAY_MS;

// An outcome is one play:
// { event_id, task_id, member, title, kind, at, claimed_at, landed_by }
// kind is took | landed | dropped | sent_back | abandoned | not_needed | held |
// could_not_start.
// abandoned is a claim that ended archived without landing; a job still in
// review is pending and not counted. not_needed is a drop or abandon that
// someone other than the member later confirmed the job never needed; it is
// not finished, so it counts for and against nobody. held is a claim let go
// because the work is done and its pull request waits for a person, but the
// proof that says so could not be saved; the release says so in a field
// (lib/release-kind.js), never in its words. It is not finished either, so it
// is neither a landing nor a miss. could_not_start is a claim a flight let go
// before the engine ran, because the build machine could not start the job; the
// release says so in a field the same way. The member never touched the work, so
// it is not finished and not a miss either. The field checks itself: a claim the
// flight marked started (a build_started event after its claim, see
// markBuildStarted in task-db.js) had its engine asked, so a release that says
// could_not_start on it is a drop like any other. at and claimed_at are epoch
// ms; claimed_at may be null. landed_by is autoland | you, only on landed.

function byTimeAsc(a, b) {
  return Number(a.at || 0) - Number(b.at || 0);
}

function isFinished(outcome) {
  return Boolean(outcome && FINISHED.has(outcome.kind));
}

// jobs = landed + dropped + sent back + abandoned in the window, the same
// count the rating divides by. Jobs still in review are pending.
function tally(outcomes) {
  const out = { took: 0, landed: 0, dropped: 0, sent_back: 0, abandoned: 0, not_needed: 0, held: 0, could_not_start: 0 };
  for (const o of outcomes || []) {
    if (Object.prototype.hasOwnProperty.call(out, o.kind)) out[o.kind] += 1;
  }
  out.finished = out.landed + out.dropped + out.sent_back + out.abandoned;
  out.jobs = out.finished;
  return out;
}

// The Atris Rating of landed over finished (lib/atris-rating.js): 25 to 99,
// where 99 means 99 of every 100, rookie under 3 finished jobs. This is
// stricter than the website rule (kept / graded) on purpose: drops and
// abandoned jobs count.
function ovr(outcomes) {
  const { landed, finished } = tally(outcomes);
  if (finished < ROOKIE_FINISHED) return null;
  return atrisRating(landed, finished);
}

// Each member's rating over one window of plays, the board's own numbers:
// ovr is 25 to 99, or null for a rookie under 3 finished. A member with no
// plays in the window is not in the map.
function memberRatings(outcomes = []) {
  const groups = new Map();
  for (const o of outcomes || []) {
    if (!o || !o.member) continue;
    if (!groups.has(o.member)) groups.set(o.member, []);
    groups.get(o.member).push(o);
  }
  return new Map([...groups].map(([name, list]) => [name, { ovr: ovr(list), finished: tally(list).finished }]));
}

// The words a member's misses came with, most often given first: the reason on
// its dropped, sent back, and abandoned plays. atris rating and the owner brief
// both show these, so both read them here.
function missReasons(outcomes, member, limit = 3) {
  const reasons = new Map();
  for (const play of outcomes || []) {
    if (play.member === member && ['dropped', 'sent_back', 'abandoned'].includes(play.kind) && play.reason) {
      reasons.set(play.reason, (reasons.get(play.reason) || 0) + 1);
    }
  }
  return [...reasons].map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)).slice(0, limit);
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

// Titles stay long here; the screen code fits them to the terminal width.
const TITLE_MAX = 200;

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
        title: clipTitle(o.title, TITLE_MAX),
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

function ownerMood(outcomes, now = Date.now(), stuck = 0, waiting = 0) {
  const since = weekStart(now);
  const week = (outcomes || []).filter(o => Number(o.at) >= since && Number(o.at) <= Number(now));
  const byAutoland = week.filter(o => o.kind === 'landed' && o.landed_by === 'autoland').length;
  const byYou = week.filter(o => o.kind === 'landed' && o.landed_by !== 'autoland').length;
  const { sent_back: sentBack, dropped, abandoned } = tally(week);
  return {
    since,
    landed_by_autoland: byAutoland,
    landed_by_you: byYou,
    sent_back: sentBack,
    dropped,
    abandoned,
    stuck,
    waiting_on_review: waiting,
    line: `this week: ${byAutoland} landed by autoland, ${byYou} by you, ${sentBack} sent back, ${dropped} dropped, ${abandoned} abandoned, ${waiting} waiting on review, ${stuck} stuck`,
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
    .map(c => ({ task_id: c.task_id, ref: c.ref || c.task_id, title: clipTitle(c.title, TITLE_MAX), member: c.member, age: c.age }));
}

// Running missions count as a job only while they moved in the last 6 hours.
function liveMissionOwners(missions = [], now = Date.now(), staleMs = STALE_MS) {
  return missions
    .filter(m => m.status === 'running' && m.owner && Number(now) - Number(m.last_at || 0) < staleMs)
    .map(m => String(m.owner));
}

// Jobs a member finished and handed in (status review), waiting on the
// reviewer, oldest first. Age counts from the proof, not the claim.
function reviewRows(reviews = [], now = Date.now(), n = 3) {
  return reviews
    .filter(r => r && r.member)
    .map(r => ({ ...r, age_ms: Math.max(0, Number(now) - Number(r.since || 0)) }))
    .sort((a, b) => b.age_ms - a.age_ms)
    .slice(0, n)
    .map(r => ({ task_id: r.task_id, ref: r.ref || r.task_id, title: clipTitle(r.title, TITLE_MAX), member: r.member, age: ageLabel(r.age_ms) }));
}

function statusByMember({ claims = [], missions = [], asleep = [], reviews = [], now = Date.now() } = {}) {
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
    const waits = reviews.filter(r => r.member === name).map(r => Number(now) - Number(r.since || 0));
    if (waits.length) return `waiting on review ${ageLabel(Math.min(...waits))}`;
    return 'idle';
  };
}

// What happened between the last interactive look and now.
function sinceLastLook(outcomes = [], lastSeen = null, now = Date.now()) {
  const seenAt = Number(lastSeen);
  if (!Number.isFinite(seenAt) || seenAt <= 0) return null;
  const after = outcomes.filter(o => Number(o.at) > seenAt && Number(o.at) <= Number(now));
  const { landed, dropped, sent_back: sentBack, abandoned } = tally(after);
  const ago = ageLabel(Number(now) - seenAt);
  const line = landed + dropped + sentBack + abandoned === 0
    ? `nothing happened since you looked ${ago} ago`
    : `since you looked (${ago} ago): ${landed} landed, ${dropped} dropped, ${sentBack} sent back, ${abandoned} abandoned`;
  return { last_seen_at: seenAt, landed, dropped, sent_back: sentBack, abandoned, line };
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
function rosterRows({ outcomes = [], claims = [], missions = [], asleep = [], reviews = [], now = Date.now(), limit = 8 } = {}) {
  const statusOf = statusByMember({ claims, missions, asleep, reviews, now });
  const holders = new Set([...claims.map(c => c.member), ...liveMissionOwners(missions, now)].filter(Boolean));
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
    status: statusOf(name),
    last_at: Math.max(...list.map(o => Number(o.at) || 0)),
  }));
  rows.sort(rosterOrder);
  for (const name of [...holders].sort()) {
    if (groups.has(name)) continue;
    rows.push({
      name,
      ...tally([]),
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
    .map(t => ({ kind: 'task', ref: t.ref || null, title: clipTitle(t.title, TITLE_MAX), owner: t.owner || null }));
  const active = missions
    .filter(m => ACTIVE_MISSION_STATUSES.has(m.status))
    .map(m => ({ kind: 'mission', ref: null, title: clipTitle(m.objective || m.slug || m.id, TITLE_MAX), owner: m.owner || null }));
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

// When a landing happened. A merge a person made on GitHub is written down later, when the sweep
// notices it, and its event says when the merge was (landed_at). The rating dates the landing by
// that, so a merge swept in weeks late does not count as news. It is never later than the event
// itself, so a time in the future cannot hold a landing inside the window; a time that cannot be
// read leaves the landing dated when it was written down.
function landedAt(row, payload) {
  const written = Number(row.created_at);
  const text = payload && typeof payload.landed_at === 'string' ? payload.landed_at.trim() : '';
  const merged = text ? Date.parse(text) : NaN;
  return Number.isFinite(merged) && Number.isFinite(written) ? Math.min(merged, written) : written;
}

function landedBy(row, payload) {
  if (payload && (payload.auto_accepted === true || payload.self_landed === true)) return 'autoland';
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
    // A release that carries the proof-not-saved fields is work waiting on a person,
    // not a drop. One that carries the could-not-start kind was let go before the
    // engine ran, so it is not a drop either, unless its claim was marked started
    // (engine_started): then the kind is false and it is a drop. Only the fields say
    // so: the same words with no fields stay a drop.
    kind = isProofNotSaved(payload) ? 'held'
      : isCouldNotStart(payload) && Number(row.engine_started) !== 1 ? 'could_not_start'
        : 'dropped';
    member = payload.previous_claimed_by || payload.released_by || row.actor;
  } else if (row.event_type === 'claim_expired') {
    kind = 'dropped';
    member = payload.claimed_by;
  } else if (isLandingRecord(row.event_type, payload)) {
    kind = 'landed';
    member = holder;
  } else if (row.event_type === 'revision_requested' || row.event_type === 'reopened') {
    kind = 'sent_back';
    member = holder;
  } else if (row.event_type === 'archived' && Number(row.abandons) === 1 && row.claim_event_id) {
    // archived before the claim landed, was let go, completed, reopened, or archived
    kind = 'abandoned';
    member = holder;
  }
  if (!kind || !member) return null;
  const claimedAt = kind === 'took' ? null : (row.claim_event_at != null ? Number(row.claim_event_at) : (row.claimed_at != null ? Number(row.claimed_at) : null));
  // One claim episode per job: a took is its own claim; anything else
  // belongs to the claim before it, or to a claim older than the history.
  const claimId = kind === 'took'
    ? (row.event_id || `${row.task_id}:${row.created_at}`)
    : (row.claim_event_id || `${row.task_id}:before`);
  const leaseUntil = typeof payload.lease_until === 'number' ? payload.lease_until : typeof payload.lease_until === 'string' ? Date.parse(payload.lease_until) : NaN;
  return {
    event_id: row.event_id || null,
    claim_id: claimId,
    task_id: row.task_id,
    member: String(member),
    title: row.title || '',
    kind,
    at: row.event_type === 'claim_expired' && Number.isFinite(leaseUntil) ? leaseUntil : kind === 'landed' ? landedAt(row, payload) : Number(row.created_at),
    reason: kind !== 'took' && kind !== 'landed' ? (typeof payload.reason === 'string' && payload.reason.trim() || typeof payload.note === 'string' && payload.note.trim() || null) : null,
    claimed_at: claimedAt,
    landed_by: kind === 'landed' ? landedBy(row, payload) : null,
  };
}

// Whether an event records a landing: a proof or landing event that names its merge, or a completion marked kept.
// The rating counts each of these as a landed play, and the builder picker (lib/builder-pick.js) reads every one of
// them, in every workspace of the store, to find which job recorded a commit first.
function isLandingRecord(eventType, payload) {
  const body = payload && typeof payload === 'object' ? payload : {};
  return ((eventType === 'proof_ready' || eventType === 'landing') && hasStructuredMerge(body)) ||
    (eventType === 'completed' && KEPT_ACTIONS.has(body.action));
}

function hasStructuredMerge(payload) {
  const objects = [payload, payload.landing, payload.pull_request, payload.pr].filter(x => x && typeof x === 'object' && !Array.isArray(x));
  return objects.some(x => {
    const commit = x.merge_commit || x.merge_commit_sha || x.merge_sha;
    return (typeof commit === 'string' && /^[0-9a-f]{7,64}$/i.test(commit)) ||
      x.merged === true || Boolean(x.merged_at) ||
      ((typeof x.merged_pr === 'string' && x.merged_pr.trim() !== '') || (typeof x.merged_pr === 'number' && x.merged_pr > 0) || (x.merged_pr && typeof x.merged_pr === 'object' && (x.merged_pr.merged === true || x.merged_pr.state === 'merged' || x.merged_pr.merged_at))) ||
      ((x.state === 'merged' || x.status === 'merged') && (x.number != null || x.url != null));
  });
}

// A drop or abandon that someone other than the member later confirmed the job
// never needed (`task archive --not-needed`) is not the member's miss, so it
// stops counting for or against them. Only another actor can clear it, and
// only within a week of the miss: a member cannot wave off its own drop. A
// note from a fleet engine never counts, whatever name it was filed under: an
// engine cannot void another engine's miss, or its own.
function clearNotNeededMisses(plays, rows) {
  const notices = rows.filter(row => row.event_type === 'not_needed');
  if (!notices.length) return;
  const { normalizeActor, isFleetEngineActor } = require('./review-integrity');
  plays.forEach((play, i) => {
    if (play.kind !== 'dropped' && play.kind !== 'abandoned') return;
    const holder = normalizeActor(play.member);
    const notice = notices.find(row => {
      const by = normalizeActor(row.actor);
      const lag = Number(row.created_at) - play.at;
      return row.task_id === play.task_id && by && by !== holder && !isFleetEngineActor(by) && lag >= 0 && lag <= NOT_NEEDED_WINDOW_MS;
    });
    if (!notice) return;
    const why = (parseJson(notice.payload) || {}).reason;
    plays[i] = { ...play, kind: 'not_needed', reason: typeof why === 'string' && why.trim() || play.reason, confirmed_by: notice.actor };
  });
}

function outcomesFromEvents(rows, since = -Infinity) {
  const ordered = [...(rows || [])].sort((a, b) => String(a.task_id).localeCompare(String(b.task_id)) ||
    (a.version != null && b.version != null ? Number(a.version) - Number(b.version) : Number(a.created_at) - Number(b.created_at)));
  const plays = [];
  const finished = new Map();
  const closed = new Set();
  for (let i = 0; i < ordered.length; i++) {
    const row = ordered[i];
    const play = outcomeFromEvent(row);
    const key = `${row.task_id}:${row.claim_event_id || `${row.task_id}:before`}`;
    const ended = ['claim_released', 'claim_expired', 'completed', 'reopened', 'archived'].includes(row.event_type);
    if (!play) { if (ended) closed.add(key); continue; }
    if (play.kind === 'took') { plays.push(play); continue; }
    // A release that another member's claim follows within two minutes reads as a hand-over, and is left out. That
    // is a rule about old history, whose releases carry no mark, and it holds for them as it always did. A release
    // on a claim the engine started (engine_started) is a real miss whoever claims next, and one that could not
    // start has its own line: neither is a hand-over, so neither is erased.
    if (row.event_type === 'claim_released' && Number(row.engine_started) !== 1 && play.kind !== 'could_not_start') {
      let next = null;
      for (let j = i + 1; j < ordered.length && ordered[j].task_id === row.task_id; j++) {
        if (ordered[j].event_type === 'claimed') { next = ordered[j]; break; }
      }
      const nextMember = next && (next.actor || (parseJson(next.payload) || {}).claimed_by);
      if (next && nextMember &&
          Number(next.created_at) >= Number(row.created_at) && Number(next.created_at) - Number(row.created_at) <= 120000 &&
          String(nextMember) !== play.member) { closed.add(key); continue; }
    }
    const prior = finished.get(key);
    if (!prior && !closed.has(key)) { finished.set(key, play); plays.push(play); }
    else if (prior && !closed.has(key) && play.kind === 'landed' && prior.kind !== 'landed') {
      plays[plays.indexOf(prior)] = play;
      finished.set(key, play);
    }
    if (ended) closed.add(key);
  }
  clearNotNeededMisses(plays, ordered);
  return plays.filter(play => play.at >= since).sort(byTimeAsc);
}

function emptySeason(workspaceRoot, now) {
  return {
    workspace_root: workspaceRoot,
    workspace_name: path.basename(workspaceRoot),
    now,
    outcomes: [],
    open_tasks: [],
    claims: [],
    reviews: [],
    asleep: [],
    missions: [],
    last_seen_at: null,
  };
}

// Last looks live under ~/.atris/state/gm-last-seen/, one small file per
// workspace named by the sha1 of its absolute path, so looking at a club never
// writes into that club's repo and two open boards never clobber each other.
// The older single map file (gm-last-seen.json) is still read as a fallback.
function lastSeenDir() {
  const { atrisHome } = require('./state-home');
  return path.join(atrisHome(), 'state', 'gm-last-seen');
}

function lastSeenKey(workspaceRoot) {
  return path.resolve(String(workspaceRoot || '.'));
}

function lastSeenPath(workspaceRoot, dir) {
  const digest = require('crypto').createHash('sha1').update(lastSeenKey(workspaceRoot)).digest('hex');
  return path.join(dir, `${digest}.json`);
}

function validSeen(value) {
  const at = Number(value);
  return Number.isFinite(at) && at > 0 ? at : null;
}

function readLastSeen(workspaceRoot, { dir = lastSeenDir() } = {}) {
  try {
    return validSeen(JSON.parse(fs.readFileSync(lastSeenPath(workspaceRoot, dir), 'utf8')).last_seen_at);
  } catch {
    // fall through to the older single map file
  }
  try {
    const legacy = JSON.parse(fs.readFileSync(path.join(path.dirname(dir), 'gm-last-seen.json'), 'utf8'));
    const entry = legacy && legacy.workspaces && legacy.workspaces[lastSeenKey(workspaceRoot)];
    return validSeen(entry && entry.last_seen_at);
  } catch {
    return null;
  }
}

// Only the interactive board writes this; --board and --json only read it.
// Written to a temp file then renamed, so a reader never sees half a file.
// A read-only or missing home just means no recap next time, never a crash.
function writeLastSeen(workspaceRoot, at = Date.now(), { dir = lastSeenDir() } = {}) {
  try {
    const file = lastSeenPath(workspaceRoot, dir);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.${require('crypto').randomBytes(4).toString('hex')}.tmp`;
    const body = { workspace: lastSeenKey(workspaceRoot), last_seen_at: at, last_seen_iso: new Date(at).toISOString() };
    fs.writeFileSync(tmp, `${JSON.stringify(body)}\n`);
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

// Right before u releases a claim: is it still held by the same member with
// no task event for 6 hours? The board's stuck list can be minutes old.
function stillStuck(taskId, member, { dbPath, now = Date.now(), staleMs = STALE_MS } = {}) {
  const taskDb = require('./task-db');
  const target = dbPath || taskDb.getDbPath();
  if (!taskId || !member || !fs.existsSync(target)) return false;
  let db;
  try {
    const { DatabaseSync } = require('node:sqlite');
    db = new DatabaseSync(target, { readOnly: true });
    const row = db.prepare(`
      SELECT status, claimed_by, claimed_at, updated_at,
             (SELECT MAX(e.created_at) FROM task_events e WHERE e.task_id = tasks.id) AS last_event_at
        FROM tasks WHERE id = ?
    `).get(taskId);
    if (!row || row.status !== 'claimed' || String(row.claimed_by) !== String(member)) return false;
    const last = Number(row.last_event_at || row.claimed_at || row.updated_at || 0);
    return Number(now) - last >= staleMs;
  } catch {
    return false;
  } finally {
    if (db) {
      try { db.close(); } catch {}
    }
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
    SELECT e.event_id, e.task_id, e.workspace_root, e.event_type, e.actor, e.payload, e.created_at, e.version,
           t.title, t.claimed_by, t.claimed_at,
           c.event_id AS claim_event_id, c.created_at AS claim_event_at, c.actor AS claim_actor,
           CASE WHEN e.event_type = 'claim_released' AND c.event_id IS NOT NULL AND EXISTS (
             SELECT 1 FROM task_events b
              WHERE b.task_id = e.task_id AND b.version > c.version AND b.version < e.version
                -- the flight marks a claim started right before it asks the assigned engine
                AND b.event_type = 'build_started'
           ) THEN 1 ELSE 0 END AS engine_started,
           CASE WHEN e.event_type = 'archived' AND c.event_id IS NOT NULL AND NOT EXISTS (
             SELECT 1 FROM task_events x
              WHERE x.task_id = e.task_id AND x.version > c.version AND x.version < e.version
                -- any completion ends the episode: a plain "done" with no
                -- accept is not a landing, but it is not abandoned either.
                -- reopened ends it too: the holder already took the sent back,
                -- so a later archive with no new claim is not also their abandon
                AND x.event_type IN ('claim_released', 'archived', 'completed', 'reopened')
           ) THEN 1 ELSE 0 END AS abandons
      FROM task_events e
      JOIN tasks t ON t.id = e.task_id
      LEFT JOIN task_events c ON c.event_id = (
        SELECT p.event_id FROM task_events p
         WHERE p.task_id = e.task_id AND p.event_type = 'claimed' AND p.version < e.version
         ORDER BY p.version DESC LIMIT 1)
     WHERE EXISTS (SELECT 1 FROM task_events recent WHERE recent.task_id = e.task_id AND recent.created_at >= ?)
       AND e.event_type IN ('claimed', 'claim_released', 'claim_expired', 'proof_ready', 'landing', 'completed', 'revision_requested', 'reopened', 'archived', 'not_needed')
       ${extraWhere}
     ORDER BY e.created_at ASC`;
}

// A workspace's plays as they stood at an earlier time: the same plays loadSeason
// would have found on that day, from the events that existed by then and nothing
// after. Working out all of the history and cutting the plays by date afterwards is
// not the same thing. A landing that came later replaces an earlier miss, and a
// later "not needed" note clears one, so the miss would be gone from a rating that
// was printed with it. Every other fact a play is built from (the claim before it,
// whether the engine had started) is an earlier event in the same job, so cutting
// the events is enough.
//
// The job's own row is the one thing that is not an earlier event. It says who holds
// the job now, and today's rating falls back on that when a play has no claim on
// record before it. For a day in the past that is the wrong answer: a job nobody held
// that day would be handed to whoever took it later, and sent back to them. So the
// holder and the claim time are cleared here. A play with no claim on record at or
// before the day has no member and is not counted, the way a job nobody held was not
// counted on that day. (Only the title is still read from the row, and it is only
// shown.) `db` is an open task store.
function outcomesAsOf(db, workspaceRoot, asOf, days = SEASON_DAYS) {
  const since = asOf - days * DAY_MS;
  const rows = db.prepare(playEventsSql('AND e.workspace_root = ? AND e.created_at <= ?')).all(since, workspaceRoot, asOf)
    .map(row => ({ ...row, claimed_by: null, claimed_at: null }));
  return outcomesFromEvents(rows, since).filter(play => play.at <= asOf);
}

// The jobs open right now whose latest release is one the rating reads as held (the
// work is done and its pull request waits for a person, but the proof could not be
// saved) or as could_not_start (the build machine never ran the job), and that nobody
// has claimed or landed since, and that has not been archived or reopened since: a
// release older than the job's latest archive or reopen is not what the job is waiting
// on, because it was closed and then opened again for new work. There is no age limit:
// loadSeason only looks back 30 days, and a job left open by a release older than that
// is still where it was left.
// Each release is read by the rating's own query and rules (the member, the kind, the
// engine_started mark), so this cannot disagree with atris rating about what a release
// was. Returns one play per job, in the shape outcomesFromEvents makes. `db` is an open
// task store.
function openReleasePlays(db, workspaceRoot) {
  const found = db.prepare(`
    SELECT r.event_id AS event_id, r.task_id AS task_id, r.version AS version
      FROM task_events r
      JOIN tasks t ON t.id = r.task_id
     WHERE t.workspace_root = ? AND t.status = 'open' AND r.event_type = 'claim_released'
       -- a first cut on the words, so only the few releases of these kinds are read in full below
       AND (r.payload LIKE '%proof_not_saved%' OR r.payload LIKE '%could_not_start%')
       AND r.version = (SELECT MAX(x.version) FROM task_events x WHERE x.task_id = r.task_id AND x.event_type = 'claim_released')
       AND NOT EXISTS (SELECT 1 FROM task_events later WHERE later.task_id = r.task_id AND later.version > r.version AND later.event_type IN ('claimed', 'archived', 'reopened'))`)
    .all(workspaceRoot);
  const release = db.prepare(playEventsSql('AND e.event_id = ?'));
  const after = db.prepare(playEventsSql('AND e.task_id = ? AND e.version > ?'));
  const plays = [];
  for (const { event_id: eventId, task_id: taskId, version } of found) {
    const play = outcomesFromEvents(release.all(0, eventId)).find(made => made.event_id === eventId);
    if (!play || (play.kind !== 'held' && play.kind !== 'could_not_start')) continue;
    if (outcomesFromEvents(after.all(0, taskId, version)).some(made => made.kind === 'landed')) continue;
    plays.push(play);
  }
  return plays;
}

// Only the plays: the same rows and the same outcome builder as loadSeason, without the board around them
// (open tasks, reviews, claims, targets, who is asleep). A reader that only counts plays uses this, because the
// rest of loadSeason costs more the more tasks the workspace has ever held. Opens the db read-only.
function loadOutcomes(workspaceRoot, { now = Date.now(), days = SEASON_DAYS, dbPath } = {}) {
  const target = dbPath || require('./task-db').getDbPath();
  if (!fs.existsSync(target)) return { outcomes: [], no_history: true };
  let db;
  try {
    const { DatabaseSync } = require('node:sqlite');
    db = new DatabaseSync(target, { readOnly: true });
    const since = now - days * DAY_MS;
    return { outcomes: outcomesFromEvents(db.prepare(playEventsSql('AND e.workspace_root = ?')).all(since, workspaceRoot), since) };
  } catch (err) {
    return { outcomes: [], error: err && err.message ? err.message : String(err) };
  } finally {
    if (db) {
      try { db.close(); } catch {}
    }
  }
}

// The one loader: last 30 days of plays for a workspace, plus open claims,
// who is asleep, and what is up next. Opens the db read-only.
// `lastSeen` pins the recap to a session's opening look; without it the
// stored look is used. A look older than the window gets its own query, so
// coming back after 40 days still counts every landing since.
function loadSeason(workspaceRoot, { now = Date.now(), days = SEASON_DAYS, dbPath, lastSeen, lastSeenDir: seenDir, targetsDir } = {}) {
  const season = emptySeason(workspaceRoot, now);
  const { asleepMembers } = require('./member-switches');
  season.asleep = asleepMembers(workspaceRoot);
  season.last_seen_at = lastSeen !== undefined ? lastSeen : readLastSeen(workspaceRoot, seenDir ? { dir: seenDir } : {});

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
  if (!fs.existsSync(target)) {
    // no task history yet: the target still shows, scored against nothing
    season.no_history = true;
    season.targets = loadTargetView(null, workspaceRoot, { now, since: now - days * DAY_MS, playsSince: null, outcomes: [], claims: [], dir: targetsDir });
    return season;
  }

  let db;
  try {
    const { DatabaseSync } = require('node:sqlite');
    db = new DatabaseSync(target, { readOnly: true });
    const since = now - days * DAY_MS;
    const playsSince = db.prepare(playEventsSql('AND e.workspace_root = ?'));
    season.outcomes = outcomesFromEvents(playsSince.all(since, workspaceRoot), since);
    const seenAt = Number(season.last_seen_at);
    season.recap_outcomes = Number.isFinite(seenAt) && seenAt > 0 && seenAt < since
      ? outcomesFromEvents(playsSince.all(seenAt, workspaceRoot), seenAt)
      : null;

    const taskRows = db.prepare(`
      SELECT id, title, status, tag, workspace_root, claimed_by, claimed_at, created_at, updated_at, metadata,
             (SELECT MAX(e.created_at) FROM task_events e WHERE e.task_id = tasks.id) AS last_event_at,
             (SELECT MAX(e.created_at) FROM task_events e WHERE e.task_id = tasks.id AND e.event_type = 'proof_ready') AS proof_at,
             (SELECT e.event_id FROM task_events e WHERE e.task_id = tasks.id AND e.event_type = 'claimed'
               ORDER BY e.version DESC LIMIT 1) AS claim_event_id
        FROM tasks WHERE workspace_root = ?
    `).all(workspaceRoot).map(row => ({ ...row, metadata: parseJson(row.metadata) || {} }));
    const live = taskDb.withTaskDisplayRefs(taskRows).filter(t => ['open', 'claimed', 'review'].includes(t.status));
    const refOf = t => t.display_id || t.legacy_ref || null;
    season.open_tasks = live
      .filter(t => t.status === 'open')
      .map(t => ({ id: t.id, ref: refOf(t), title: t.title, created_at: t.created_at, owner: t.metadata.assigned_to || null }));
    season.reviews = live
      .filter(t => t.status === 'review' && t.claimed_by)
      .map(t => ({
        task_id: t.id,
        ref: refOf(t),
        title: t.title,
        member: String(t.claimed_by),
        since: Number(t.proof_at || t.last_event_at || t.updated_at || 0),
        // Done, and its pull request still open for a person to land. The rating never asks
        // GitHub; `atris task sweep --held` does, and credits the builder when it was merged.
        ...(taskDb.heldPullRequestOf(t) ? { waiting_on_pull_request: true } : {}),
      }));
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

    season.targets = loadTargetView(db, workspaceRoot, { now, since, playsSince, outcomes: season.outcomes, claims: season.claims, dir: targetsDir });
  } catch (err) {
    season.error = err && err.message ? err.message : String(err);
  } finally {
    if (db) {
      try { db.close(); } catch {}
    }
  }
  return season;
}

// The owner's weekly target for this workspace: this week's standing, the
// suggested default, and the season record over completed target weeks.
// Plays older than the 30 day window are read only when a view needs them.
function loadTargetView(db, workspaceRoot, { now, since, playsSince, outcomes, claims, dir }) {
  const gmTarget = require('./gm-target');
  const store = gmTarget.readTargets(workspaceRoot, dir ? { dir } : {});
  const from = gmTarget.historyStart(store, now);
  const history = db && from < since ? outcomesFromEvents(playsSince.all(from, workspaceRoot), from) : outcomes;
  const hasPastWeeks = Object.keys(store.weeks).some(k => k < gmTarget.weekKey(now));
  return {
    has_target: Object.keys(store.weeks).length > 0,
    current: gmTarget.currentStatus({ store, outcomes: history, claims, now }),
    default: gmTarget.defaultTarget(history, now),
    record: gmTarget.seasonRecord({
      store,
      outcomes: history,
      eventsByTask: db && hasPastWeeks ? gmTarget.loadClaimHistory(db, workspaceRoot, from) : new Map(),
      now,
    }),
  };
}

// Everything the board needs, computed from a loaded season. `seen` holds
// play ids from the last draw so new plays can be tagged. `lastSeen`
// overrides the stored last look (the interactive board pins it per session).
function seasonBoard(season, { limit = 8, seen = null, lastSeen } = {}) {
  const stuckAll = claimStates(season.claims, season.now).filter(c => c.stuck);
  const recapFrom = lastSeen === undefined ? season.last_seen_at : lastSeen;
  return {
    workspace_name: season.workspace_name,
    now: season.now,
    week_of: weekStart(season.now),
    mood: ownerMood(season.outcomes, season.now, stuckAll.length, (season.reviews || []).length),
    since_last_look: sinceLastLook(season.recap_outcomes || season.outcomes, recapFrom, season.now),
    roster: rosterRows({
      outcomes: season.outcomes,
      claims: season.claims,
      missions: season.missions,
      asleep: season.asleep,
      reviews: season.reviews || [],
      now: season.now,
      limit,
    }),
    // two kinds of jam: work waiting on a reviewer, and claims stuck with
    // the player. With both on screen, each gets three rows.
    waiting_on_review: reviewRows(season.reviews || [], season.now, 3),
    waiting_on_review_total: (season.reviews || []).length,
    stuck: stuckRows(season.claims, season.now, (season.reviews || []).length ? 3 : 5),
    last_plays: lastPlays(season.outcomes, 5, seen),
    up_next: upNext({ openTasks: season.open_tasks, missions: season.missions }),
    // the owner's weekly target: this week's standing (null with no target),
    // the suggested default, and the record over completed target weeks
    target: season.targets ? season.targets.current : null,
    target_default: season.targets ? season.targets.default : null,
    record: season.targets && season.targets.has_target ? season.targets.record : null,
    no_history: Boolean(season.no_history),
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
// Names grow one parent folder at a time until every label is unique, so
// /one/common/app and /two/common/app become one/common/app and two/common/app.
function clubNames(roots) {
  const parts = new Map(roots.map(root => [root, String(root).split('/').filter(Boolean)]));
  const depth = new Map(roots.map(root => [root, 1]));
  const label = root => parts.get(root).slice(-depth.get(root)).join('/') || root;
  for (let pass = 0; pass < 64; pass += 1) {
    const seen = new Map();
    for (const root of roots) {
      const name = label(root);
      if (!seen.has(name)) seen.set(name, []);
      seen.get(name).push(root);
    }
    const clashes = [...seen.values()].filter(group => group.length > 1);
    if (!clashes.length) break;
    let grew = false;
    for (const group of clashes) {
      for (const root of group) {
        if (depth.get(root) < parts.get(root).length) {
          depth.set(root, depth.get(root) + 1);
          grew = true;
        }
      }
    }
    if (!grew) break;
  }
  return new Map(roots.map(root => [root, label(root)]));
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
      abandoned_30d: counts.abandoned,
      finished_30d: counts.finished,
      stuck: claimStates(club.claims || [], now).filter(c => c.stuck).length,
      last_play_at: lastAt || null,
      last_play: lastAt ? ageLabel(now - lastAt) : '-',
      best_player: best ? { name: best.name, ovr: best.ovr } : null,
      target: club.target ? club.target.verdict : null,
    };
  }).sort(leagueOrder);
}

// Reads every workspace's plays for the window in one pass, read-only.
function loadLeague({ now = Date.now(), days = SEASON_DAYS, dbPath, isClub = isClubRoot, targetsDir } = {}) {
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
    `).all(since).filter(row => isClub(row.root) && fs.existsSync(row.root));
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
    const gmTarget = require('./gm-target');
    league.clubs = [...byRoot.values()].map((club) => {
      const outcomes = outcomesFromEvents(club.events, since);
      const store = gmTarget.readTargets(club.root, targetsDir ? { dir: targetsDir } : {});
      return {
        root: club.root,
        last_event_at: club.last_event_at,
        outcomes,
        claims: club.claims,
        target: gmTarget.currentStatus({ store, outcomes, claims: club.claims, now }),
      };
    });
  } catch (err) {
    league.error = err && err.message ? err.message : String(err);
  } finally {
    if (db) {
      try { db.close(); } catch {}
    }
  }
  return league;
}

// Clubs with fewer than 3 finished jobs in the window are quiet: counted,
// not listed, so experiment folders do not bury the real projects.
function leagueBoard(league) {
  const all = leagueRows(league.clubs, league.now);
  const rows = all.filter(row => row.finished_30d >= ROOKIE_FINISHED);
  return {
    now: league.now,
    days: SEASON_DAYS,
    rows,
    hidden: all.length - rows.length,
    hidden_clubs: all.filter(row => row.finished_30d < ROOKIE_FINISHED).map(row => ({ club: row.club, root: row.root })),
    error: league.error || null,
  };
}

// ---- player card: one member's profile page --------------------------------

const CARD_WEEKS = 6;
const SCOUT_WINDOW = 30;
const SCOUT_WORDS = { dropped: 'drops jobs', abandoned: 'abandons jobs', sent_back: 'gets sent back' };

// The honest rating per calendar week (monday to monday), oldest first, for
// the last `weeks` weeks including this one. null is a rookie week.
function weeklyRatings(outcomes = [], now = Date.now(), weeks = CARD_WEEKS) {
  const thisWeek = weekStart(now);
  const out = [];
  for (let i = weeks - 1; i >= 0; i -= 1) {
    const start = weekStart(thisWeek - i * 7 * DAY_MS + DAY_MS);
    const end = i === 0 ? Number(now) + 1 : weekStart(start + 8 * DAY_MS);
    out.push(ovr(outcomes.filter(o => Number(o.at) >= start && Number(o.at) < end)));
  }
  return out;
}

// Median hours from claim to landing, one decimal, or null with no landings.
function medianLandingHours(outcomes = []) {
  const hours = outcomes.filter(o => o.kind === 'landed').map(outcomeHours).filter(h => h != null).sort((a, b) => a - b);
  if (!hours.length) return null;
  const mid = Math.floor(hours.length / 2);
  const value = hours.length % 2 ? hours[mid] : (hours[mid - 1] + hours[mid]) / 2;
  return Math.round(value * 10) / 10;
}

// One plain scouting line: the outcome it most often has besides landing,
// over its last 30 finished jobs, or a clean sheet.
function scoutingLine(outcomes = []) {
  const recent = [...outcomes].filter(isFinished).sort(byTimeAsc).slice(-SCOUT_WINDOW);
  if (!recent.length) return 'no finished jobs to scout yet';
  const counts = tally(recent);
  const misses = ['dropped', 'abandoned', 'sent_back']
    .map(kind => [kind, counts[kind]])
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);
  if (!misses.length) return `clean sheet: landed all ${recent.length} of its last ${recent.length} finished`;
  const [kind, n] = misses[0];
  return `${SCOUT_WORDS[kind]}: ${n} of last ${recent.length} finished`;
}

function frontmatterField(text, field) {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(text || ''));
  if (!block) return null;
  const match = new RegExp(`^${field}:\\s*(.*)$`, 'm').exec(block[1]);
  const value = match ? match[1].trim().replace(/^["']|["']$/g, '') : '';
  return value || null;
}

// Names close to a typed one: same start, contains it, or a small edit away.
function closeNames(wanted, names = [], limit = 5) {
  const w = String(wanted || '').toLowerCase();
  const distance = (a, b) => {
    const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j += 1) dp[0][j] = j;
    for (let i = 1; i <= a.length; i += 1) {
      for (let j = 1; j <= b.length; j += 1) {
        dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
    }
    return dp[a.length][b.length];
  };
  return [...new Set(names)]
    .map(name => ({ name, d: distance(w, name.toLowerCase()), near: name.toLowerCase().includes(w) || w.includes(name.toLowerCase()) }))
    .filter(x => x.near || x.d <= Math.max(2, Math.floor(w.length / 3)))
    .sort((a, b) => (b.near - a.near) || a.d - b.d || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map(x => x.name);
}

// Everything on the card, from a season loaded over the last 6 weeks. Pure.
function memberCard(name, season, { role = null, engine = null, now = season.now } = {}) {
  const mine = season.outcomes.filter(o => o.member === name);
  const since30 = Number(now) - SEASON_DAYS * DAY_MS;
  const last30 = mine.filter(o => Number(o.at) >= since30);
  const counts = tally(last30);
  const claims = claimStates(season.claims.filter(c => c.member === name), now);
  const live = claims.filter(c => !c.stuck).sort((a, b) => a.age_ms - b.age_ms)[0];
  const stuck = claims.filter(c => c.stuck).sort((a, b) => a.age_ms - b.age_ms)[0];
  const mission = season.missions.find(m => m.status === 'running' && m.owner === name && Number(now) - Number(m.last_at || 0) < STALE_MS);
  let status = { state: 'idle', title: null };
  if (live) status = { state: 'on a job', title: live.title };
  else if (mission) status = { state: 'on a job', title: mission.objective || mission.slug || mission.id };
  else if (stuck) status = { state: `stuck ${stuck.age}`, title: stuck.title };
  return {
    name,
    workspace_name: season.workspace_name,
    role,
    awake: !season.asleep.includes(name),
    status,
    ovr: ovr(last30),
    weekly: weeklyRatings(mine, now),
    record_30d: { landed: counts.landed, dropped: counts.dropped, sent_back: counts.sent_back, abandoned: counts.abandoned },
    median_landing_hours: medianLandingHours(last30),
    engine,
    scouting: scoutingLine(mine),
    last_plays: [...mine].sort((a, b) => byTimeAsc(b, a)).slice(0, 8).map(o => ({
      at: o.at,
      outcome: PLAY_WORD[o.kind],
      title: clipTitle(o.title, TITLE_MAX),
    })),
    now,
  };
}

// The card's loader: 6 weeks of plays, role from MEMBER.md, and the engine
// only when a roster line or the member file records one. Read-only. Returns
// { card } or { error, close } for a name nobody knows.
function loadCard(workspaceRoot, name, { now = Date.now(), dbPath } = {}) {
  const wanted = String(name || '').trim();
  const days = Math.ceil((Number(now) - (weekStart(now) - (CARD_WEEKS - 1) * 7 * DAY_MS)) / DAY_MS) + 1;
  const season = loadSeason(workspaceRoot, { now, days, dbPath, lastSeen: null });
  if (season.error) return { error: `could not read the task list: ${season.error}`, close: [] };
  const teamDir = path.join(workspaceRoot, 'atris', 'team');
  let team = [];
  try {
    team = fs.readdirSync(teamDir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name);
  } catch {
    team = [];
  }
  const known = new Set([...team, ...season.outcomes.map(o => o.member), ...season.claims.map(c => c.member)]);
  if (!wanted || !known.has(wanted)) {
    return { error: `no member called "${wanted}" in ${season.workspace_name}`, close: closeNames(wanted, [...known]) };
  }
  // Names can come from task data, so a holder like ../../somewhere still
  // gets a card from its history, but nothing is read from disk for it.
  if (!isSafeMemberName(wanted)) {
    return { card: memberCard(wanted, season, { role: null, engine: null, now }), error: null };
  }
  let memberText = null;
  try {
    memberText = fs.readFileSync(path.join(teamDir, wanted, 'MEMBER.md'), 'utf8');
  } catch {
    memberText = null;
  }
  const role = frontmatterField(memberText, 'role');
  let engine = null;
  const fileEngine = frontmatterField(memberText, 'engine') || frontmatterField(memberText, 'executed_by');
  const fileModel = frontmatterField(memberText, 'model');
  if (fileEngine) engine = { engine: fileEngine, model: fileModel, source: `atris/team/${wanted}/MEMBER.md` };
  if (!engine) engine = rosterEngine(wanted, workspaceRoot, { role: role || '', hasCard: memberText != null });
  return { card: memberCard(wanted, season, { role, engine, now }), error: null };
}

// Only letters, digits, dot, dash, underscore, and no leading dot: no path
// separators and never . or .. so a name can never leave atris/team.
function isSafeMemberName(name) {
  return /^[a-z0-9_-][a-z0-9._-]*$/i.test(String(name || ''));
}

// The engine the roster file declares for this member, read straight from the
// roster text with no check of what this machine has installed (policy, not
// a probe): the member's own team line, else the job section its known job
// falls under ("## build"), first worker first, with that file and line. With
// no member card and no team line the job is not known, so nothing is shown.
function rosterEngine(name, workspaceRoot, { rosterState, role = '', hasCard = true } = {}) {
  try {
    const reg = require('./engine-registry');
    const { autoJobForMember } = require('./member-engine');
    const state = rosterState || reg.readRosterState(workspaceRoot);
    const layers = reg.ROSTER_LAYERS || ['session', 'project', 'machine'];
    const key = String(name || '').trim().toLowerCase();
    let teamLine = null;
    for (const scope of layers) {
      const layer = state[scope];
      const hit = layer && Array.isArray(layer.team) ? layer.team.find(t => t.member === key) : null;
      if (hit) {
        teamLine = { ...hit, file: hit.file || layer.file || layer.path };
        break;
      }
    }
    if (!teamLine && !hasCard) return null;
    const kind = autoJobForMember(name, role || '');
    let jobKey = reg.ENGINE_JOBS[kind];
    if (teamLine) {
      const asJob = reg.rosterJobKey(teamLine.value);
      const saved = scope => Boolean(asJob && state[scope] && state[scope].picks && state[scope].picks[asJob]);
      if (asJob && (reg.ENGINE_ROLES.includes(asJob) || layers.some(saved))) {
        jobKey = asJob;
      } else {
        const pick = reg.rosterPickFromValue(String(teamLine.value), reg.ENGINE_JOBS[kind]);
        const lead = (pick && Array.isArray(pick.workers) && pick.workers[0]) || pick;
        if (!lead || !lead.engine || !teamLine.file) return null;
        return { engine: lead.engine, model: lead.model || null, source: `${teamLine.file}${teamLine.line ? ` line ${teamLine.line}` : ''}` };
      }
    }
    for (const scope of layers) {
      const layer = state[scope];
      const pick = layer && layer.picks && layer.picks[jobKey];
      if (!pick) continue;
      const lead = (Array.isArray(pick.workers) && pick.workers[0]) || pick;
      const file = pick.file || layer.file || layer.path;
      if (!lead || !lead.engine || !file) continue;
      return {
        engine: lead.engine,
        model: lead.model || pick.model || null,
        source: `the ${reg.rosterJobLabel(jobKey)} job in ${file}${lead.line ? ` line ${lead.line}` : ''}`,
      };
    }
    return null;
  } catch {
    return null;
  }
}

// ---- replay: a time-lapse of a window of plays -----------------------------

const REPLAY_TARGET_MS = 75 * 1000;
const REPLAY_MIN_PLAY_MS = 150;
const REPLAY_MAX_PLAY_MS = 1500;
const REPLAY_MIN_TOTAL_MS = 1500;
const REPLAY_DEFAULT_SINCE_MS = 12 * HOUR_MS;
const REPLAY_TICKER = 6;

// "12h", "2d", "30m", or "last-seen". With no value, the last look, else 12h.
// Returns { since, label } or null when the text makes no sense.
function parseSince(text, { now = Date.now(), lastSeen = null } = {}) {
  const raw = String(text == null ? '' : text).trim().toLowerCase();
  const seen = Number(lastSeen);
  const hasSeen = Number.isFinite(seen) && seen > 0 && seen < now;
  if (!raw || raw === 'last-seen' || raw === 'last') {
    if (hasSeen) return { since: seen, label: 'your last look' };
    if (raw === 'last-seen' || raw === 'last') return { since: now - REPLAY_DEFAULT_SINCE_MS, label: '12h (no last look yet)' };
    return { since: now - REPLAY_DEFAULT_SINCE_MS, label: '12h' };
  }
  const match = raw.match(/^(\d+(?:\.\d+)?)\s*(m|min|h|d|w)$/);
  if (!match) return null;
  const unit = { m: 60 * 1000, min: 60 * 1000, h: HOUR_MS, d: DAY_MS, w: 7 * DAY_MS }[match[2]];
  const span = Number(match[1]) * unit;
  if (!(span > 0)) return null;
  return { since: now - span, label: raw };
}

// Time per play so the window plays in about 75 seconds: never faster than
// one play per 150ms, never slower than 1.5s a play, and at least 1.5s in
// all. `speed` multiplies on top (2 = twice as fast).
function replayDelayMs(playCount, speed = 1) {
  const n = Math.max(0, Number(playCount) || 0);
  if (!n) return 0;
  let per = Math.min(REPLAY_MAX_PLAY_MS, Math.max(REPLAY_MIN_PLAY_MS, REPLAY_TARGET_MS / n));
  if (per * n < REPLAY_MIN_TOTAL_MS) per = REPLAY_MIN_TOTAL_MS / n;
  const mult = Number(speed) > 0 ? Number(speed) : 1;
  return Math.max(1, Math.round(per / mult));
}

function replayKey(play, byClub) {
  return byClub ? (play.club || '?') : play.member;
}

// Rows of the replay, fixed for the whole run: the most active members (or
// clubs in league mode) in the window, so lines never jump around.
function replayRows(plays = [], { byClub = false, limit = 10 } = {}) {
  const counts = new Map();
  for (const p of plays) {
    const key = replayKey(p, byClub);
    if (!key) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit).map(([key]) => key);
}

// The state after plays[0..index]: running tallies per row, the last six
// plays newest first (the newest marked), and who landed on this frame.
function replayFrame(plays = [], index = 0, { byClub = false, rows = null } = {}) {
  const shown = rows || replayRows(plays, { byClub });
  const upto = plays.length ? plays.slice(0, Math.max(0, Math.min(index, plays.length - 1)) + 1) : [];
  const byKey = new Map(shown.map(key => [key, []]));
  for (const p of upto) {
    const list = byKey.get(replayKey(p, byClub));
    if (list) list.push(p);
  }
  const current = upto[upto.length - 1] || null;
  const ticker = upto.slice(-REPLAY_TICKER).reverse().map((p, i) => ({ ...p, newest: i === 0, play: PLAY_WORD[p.kind] }));
  const rowsOut = shown.map((key) => {
    const t = tally(byKey.get(key));
    return {
      key,
      landed: t.landed,
      dropped: t.dropped,
      sent_back: t.sent_back,
      abandoned: t.abandoned,
      bump: Boolean(current && current.kind === 'landed' && replayKey(current, byClub) === key),
    };
  });
  return { index: upto.length - 1, total: plays.length, at: current ? current.at : null, rows: rowsOut, ticker };
}

// One closing line: totals for the window plus the jams left on the belt.
function replaySummary(plays = [], { stuck = [], since, now = Date.now() } = {}) {
  const t = tally(plays);
  const word = Number(now) - Number(since) <= DAY_MS ? 'night total' : 'window total';
  const jams = stuck.length
    ? `, ${stuck.length} stuck ${stuck.length === 1 ? 'jam' : 'jams'} at ${[...new Set(stuck.map(s => s.member))].slice(0, 3).join(', ')}`
    : ', no stuck jams';
  return `${word}: ${t.landed} landed, ${t.dropped} dropped, ${t.sent_back} sent back, ${t.abandoned} abandoned${jams}`;
}

// Plays since a time for one workspace (or every club with league), plus the
// claims stuck right now. Read-only.
function loadReplay({ workspaceRoot = null, since, now = Date.now(), dbPath, league = false, isClub = isClubRoot } = {}) {
  const out = { since, now, plays: [], stuck: [], error: null };
  const taskDb = require('./task-db');
  const target = dbPath || taskDb.getDbPath();
  if (!fs.existsSync(target)) return out;
  let db;
  try {
    const { DatabaseSync } = require('node:sqlite');
    db = new DatabaseSync(target, { readOnly: true });
    const keep = league ? (root => isClub(root)) : (root => root === workspaceRoot);
    const rows = league
      ? db.prepare(playEventsSql()).all(since)
      : db.prepare(playEventsSql('AND e.workspace_root = ?')).all(since, workspaceRoot);
    const kept = rows.filter(row => keep(row.workspace_root));
    // same unique labels as the league, so /one/app and /two/app stay apart
    const names = clubNames([...new Set(kept.map(row => row.workspace_root))]);
    const clubOf = root => names.get(root) || path.basename(root);
    const rootByTask = new Map(kept.map(row => [row.task_id, row.workspace_root]));
    out.plays = outcomesFromEvents(kept, since).filter(play => play.at <= now)
      .map(play => ({ ...play, club: clubOf(rootByTask.get(play.task_id)) }));
    const claimed = db.prepare(`
      SELECT id, workspace_root, claimed_by, claimed_at, updated_at,
             (SELECT MAX(e.created_at) FROM task_events e WHERE e.task_id = tasks.id) AS last_event_at
        FROM tasks WHERE status = 'claimed' AND claimed_by IS NOT NULL
    `).all().filter(t => keep(t.workspace_root));
    out.stuck = claimStates(claimed.map(t => ({
      task_id: t.id,
      member: String(t.claimed_by),
      last_event_at: Number(t.last_event_at || t.claimed_at || t.updated_at || 0),
    })), now).filter(c => c.stuck);
  } catch (err) {
    out.error = err && err.message ? err.message : String(err);
  } finally {
    if (db) {
      try { db.close(); } catch {}
    }
  }
  return out;
}

module.exports = {
  ageLabel,
  closeNames,
  isLandingRecord,
  isSafeMemberName,
  rosterEngine,
  loadCard,
  medianLandingHours,
  memberCard,
  scoutingLine,
  weeklyRatings,
  loadReplay,
  parseSince,
  replayDelayMs,
  replayFrame,
  replayRows,
  replaySummary,
  reviewRows,
  isClubRoot,
  leagueBoard,
  leagueRows,
  loadLeague,
  clockLabel,
  form,
  lastPlays,
  loadOutcomes,
  loadSeason,
  memberRatings,
  missReasons,
  openReleasePlays,
  outcomesAsOf,
  outcomesFromEvents,
  ovr,
  ownerMood,
  readLastSeen,
  rosterRows,
  SEASON_DAYS,
  seasonBoard,
  sinceLastLook,
  stillStuck,
  stuckRows,
  tally,
  upNext,
  weekStart,
  writeLastSeen,
};
