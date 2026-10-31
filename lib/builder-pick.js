'use strict';

// The rating picks the builder. The fleet used to deal engines to jobs in turn, whatever each engine had
// landed. Now each job's candidates are ordered by a draw from the engine's real results: the same plays
// the rating counts (lib/gm-season.js), read from the same task store. The flight says why in one plain
// line under the job and keeps that line in its receipt.
//
// How a draw works. For one job, a candidate has landed some of its plays and missed others since steering
// began. Plays on jobs in this job's lane count in full and plays on other jobs count half. The candidate's
// score is one draw from Beta(1 + landed, 1 + missed), so a strong record leads most days, a weak one rarely
// does, and an engine nobody has tried yet gets its turn, which is how it earns a record. The highest draw
// leads. The draw is seeded by the job's row id and the UTC day: the same job on the same day with the same
// results always gets the same order, and every candidate has its own stream, so adding or dropping one
// candidate never reshuffles the others.
//
// What counts, beyond what the rating counts:
//   - A landing counts only when it belongs to its job (lib/landing-check.js): its commit is on origin's
//     default branch, is no older than the claim it lands (five minutes of clock skew allowed), and no other claim
//     recorded the same commit first. A commit counts once, for the first claim that recorded it: not again for a
//     later claim on the same job (reopened and claimed again, by the same engine or another) and not for another
//     job. "First" is read from every landing record in the whole store (every workspace that shares it, every review
//     pass of a job), each filed under the claim it was made under, in the order the store recorded them, and a tie
//     in time goes to the record inserted first. A commit nobody recorded as a landing can still be claimed by a job
//     that did not make it; that is accepted. Misses always count.
//   - A landing pays the engine that finished it. A flight whose engine died hands the retry in under the engine
//     that finished it (lib/task-db.js readyTask records handed_in_by and built_with), and that engine is credited,
//     not the one that died. A landing whose hand-in names more than one engine and does not say which finished
//     counts for no engine's steering. The rating's own display still credits the claim holder.
//   - Where the results come from, in this order, for the folder the jobs are in:
//       One. No git, no origin, or no origin/HEAD: no landing can be checked. Jobs are dealt in turn, with one line.
//       Two. An engine's own landing is on record: origin's default branch is fetched once, so a merge from a minute
//            ago is known. If the fetch fails, jobs are dealt in turn, with one line. If it works, the landings are
//            checked and the draw steers.
//       Three. Only misses are on record: they steer by themselves, with no fetch. An engine nobody has tried gets
//            its turn, and the engine that missed gets fewer jobs.
//     Counting only the misses because the landings could not be checked would punish every engine for not being
//     checkable, so in One and Two nothing is counted.
//   - Everything git does before a pick shares one budget of five seconds and never prompts a person.
//   - A play's lane is the lane its job was in when the claim was made. The claim saves the job's title and tags
//     on itself (lib/task-db.js claimTask and the claim `task do` makes), so tagging or renaming a finished job
//     later changes nothing. A claim without that counts at the outside-lane weight, on the landed side and the
//     missed side alike, and is never rebuilt from the job's history.
//
// What it leaves alone: explicit choices are resolved first and are never picked for. A job that names its
// engine, a job assigned to a member (that member's own engine, by the resolver every member command uses), and
// a roster's backup order all stand, whether or not anyone has a result yet and whether or not that engine is
// resting. An engine list a caller names is never filtered, on the first pick or on a retry. A choice the flight
// cannot give (an engine, or the engine a member's roster resolves to, that is not in this flight's roster) is
// never given to someone else: the job is left out of the flight, with one line naming the job and why. It is taken
// out before the flight is staffed, so it takes no slot and holds no file or blind place against another job. The
// words the pick went on (the member a job is assigned to and the engine it names) are asked again when the flight
// claims the job, inside the claim's own transaction: a job that says something else by then is not claimed for the
// old choice, and is left for the next flight with one line. Otherwise
// steering never picks an engine that is resting (out of credit, cooling after a stall) or that the Claude spend
// guard would stop in an unattended run: judged on the --model of the launch the fleet itself makes
// (lib/runner-command.js launchFor), in the environment the worker will really run in. A launch template somebody
// wrote is never read for its model; that counts as paid, and the line says the model could not be told. When
// steering is off, or nobody has a result yet, jobs are dealt in turn as they always were.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { tally, isLandingRecord } = require('./gm-season');
const { taskTagTokens } = require('./task-decision');
const { normalizeActor } = require('./review-integrity');
const { commitsOf, createLandingCheck } = require('./landing-check');
const { unattendedStop } = require('./claude-spend-guard');

// Steering starts everyone even on this day. The last 30 days of plays hold old-flow damage: 27 jobs
// closed upstream were counted as one engine's misses on 10-13, and releases were forced before 3.74.28.
// Counting that history would steer by damage, not by work, so only plays whose claim began at or after
// this start count. ATRIS_PICK_SINCE (an ISO date) overrides it, for tests and for a reset.
const STEERING_START = '2026-11-01T00:00:00Z';

const DAY_MS = 24 * 60 * 60 * 1000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const OTHER_LANE_WEIGHT = 0.5;

function dayLabel(ms) {
  const date = new Date(ms);
  return `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}`;
}

// The start steering counts from: { ms, iso, label }. A date nobody can read falls back to the named day.
function steeringStart(env = process.env) {
  const text = String((env && env.ATRIS_PICK_SINCE) || '').trim();
  // An ISO date, with or without a time. Anything else is not read: Date.parse guesses at odd text.
  let ms = /^\d{4}-\d{2}-\d{2}(?:[T ]|$)/.test(text) ? Date.parse(text) : NaN;
  if (!Number.isFinite(ms)) ms = Date.parse(STEERING_START);
  return { ms, iso: new Date(ms).toISOString(), label: dayLabel(ms) };
}

// "turns" or "rating", whatever the case; anything else is not a pick.
function parsePickFlag(value) {
  const text = String(value == null ? '' : value).trim().toLowerCase();
  return text === 'turns' || text === 'rating' ? text : null;
}

// Steering is on unless someone turns it off. An explicit flag is a choice and beats the environment, a habit.
function pickMode(flag, env = process.env) {
  const flagged = parsePickFlag(flag);
  if (flagged) return flagged;
  return parsePickFlag(env && env.ATRIS_PICK) === 'turns' ? 'turns' : 'rating';
}

// The job's row id plus the UTC day: every hour of one day is the same draw.
function pickSeed(id, now = Date.now()) {
  return `${id}|${new Date(now).toISOString().slice(0, 10)}`;
}

// A job's lane, read the way the protected-lane check reads its tags (lib/fleet.js protectedLaneOfTask):
// the tag, tags, metadata tags and #hashtags in the title, then the todo tags it was imported with.
function laneTokens(task) {
  if (!task || typeof task !== 'object') return [];
  const todoTags = task.metadata && Array.isArray(task.metadata.todo_tags) ? task.metadata.todo_tags : [];
  const tokens = [...taskTagTokens(task), ...todoTags.filter(Boolean).map((tag) => String(tag).trim().toLowerCase())];
  return [...new Set(tokens.filter(Boolean))];
}

// ---------------------------------------------------------------------------
// The draw.

// A small seeded generator (mulberry32). One stream per seed and candidate.
function streamFor(seed, name) {
  let state = crypto.createHash('sha256').update(`${seed}|${name}`).digest().readUInt32BE(0);
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normalDraw(rand) {
  let u = 0;
  while (u === 0) u = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

// Marsaglia and Tsang. Every shape here is at least 1 (the prior is 1), the case this method covers.
function gammaDraw(shape, rand) {
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x;
    let v;
    do {
      x = normalDraw(rand);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rand();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

function betaDraw(alpha, beta, rand) {
  const a = gammaDraw(alpha, rand);
  const b = gammaDraw(beta, rand);
  return a / (a + b);
}

// ---------------------------------------------------------------------------
// What counts.

function unique(list) {
  return [...new Set((list || []).map((item) => String(item == null ? '' : item).trim()).filter(Boolean))];
}

// The plays one engine made since the start, whose claim began at or after it. A play with no claim time
// belongs to a claim older than the history, so it cannot be dated and is left out.
function playsOf(plays, name, since) {
  const member = normalizeActor(`fleet-${name}`);
  return (plays || []).filter((play) => play && normalizeActor(play.member) === member
    && play.claimed_at != null && Number(play.claimed_at) >= since);
}

// Landed and missed come from the rating's own count (gm-season tally): landed is a landing, finished is
// landed plus every miss the rating counts. Held, could-not-start and not-needed plays are neither.
function record(plays, name, since, lane) {
  const own = playsOf(plays, name, since);
  const inLane = (play) => {
    // A lane history could not vouch for (null) is outside the job's lane, whatever the job: it counts at the
    // outside weight on the landed side and on the missed side alike.
    if (play.lane === null) return false;
    return lane.size > 0
      ? (play.lane || []).some((token) => lane.has(token))
      // A job with no tags is its own lane: plays on other untagged jobs are the jobs most like it.
      : !(play.lane || []).length;
  };
  const all = tally(own);
  const here = tally(own.filter(inLane));
  const elsewhere = tally(own.filter((play) => !inLane(play)));
  return {
    name,
    landed: all.landed,
    counted: all.finished,
    laneLanded: here.landed,
    laneMissed: here.finished - here.landed,
    otherLanded: elsewhere.landed,
    otherMissed: elsewhere.finished - elsewhere.landed,
  };
}

function haveResults(plays, names, since) {
  return names.some((name) => tally(playsOf(plays, name, since)).finished > 0);
}

// ---------------------------------------------------------------------------
// The pick and its line.

function ofRecord(r) {
  return r.counted > 0 ? `${r.landed} of ${r.counted}` : 'new';
}

function pickLine({ records, picked, lane, since, full }) {
  const mine = records.find((r) => r.name === picked);
  const laneName = lane.length ? String(lane[0]).slice(0, 24) : '';
  const results = mine.counted > 0 ? `landed ${mine.landed} of ${mine.counted} since ${dayLabel(since)}` : `no results yet since ${dayLabel(since)}`;
  // The lane's own record is quoted only when it says something the overall record does not.
  const laneCounted = mine.laneLanded + mine.laneMissed;
  const inLane = lane.length && laneCounted > 0 && !(laneCounted === mine.counted && mine.laneLanded === mine.landed)
    ? `, ${mine.laneLanded} of ${laneCounted} on jobs like it` : '';
  const others = records.filter((r) => r.name !== picked)
    .map((r) => `fleet-${r.name} ${ofRecord(r)}${full.includes(r.name) ? ' but has its share' : ''}`);
  return `picked fleet-${picked} for this ${laneName ? `${laneName} ` : ''}job: ${results}${inLane}${others.length ? ` (${others.join(', ')})` : ''}`;
}

// Order one job's candidates by a draw from what each has done. `candidates` arrive in the order the fleet
// would use today (every health, cooldown and roster check already applied) and keep that order for ties.
// `full` names the engines with no room left: the order stays the draw, and `picked` is the first with room.
function pickBuilders({ candidates = [], job = {}, plays = [], since = steeringStart().ms, seed = '', full = [] } = {}) {
  const names = unique(candidates);
  const lane = new Set(Array.isArray(job && job.lane) ? job.lane : []);
  const records = names.map((name) => record(plays, name, since, lane));
  const scored = records.map((r, index) => {
    const rand = streamFor(seed, r.name);
    const alpha = 1 + r.laneLanded + OTHER_LANE_WEIGHT * r.otherLanded;
    const beta = 1 + r.laneMissed + OTHER_LANE_WEIGHT * r.otherMissed;
    return { r, index, score: betaDraw(alpha, beta, rand) };
  }).sort((a, b) => b.score - a.score || a.index - b.index);
  const order = scored.map((entry) => entry.r.name);
  const noRoom = unique(full);
  const picked = order.find((name) => !noRoom.includes(name)) || order[0] || null;
  return {
    order,
    picked,
    line: picked ? pickLine({ records, picked, lane: [...lane], since, full: noRoom }) : '',
    records: records.map((r) => ({ ...r, score: scored.find((entry) => entry.r === r).score })),
  };
}

// ---------------------------------------------------------------------------
// The rating's own plays, from the task store.

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ---- what each play knew when it was made -----------------------------------------------------------------
//
// The lane of a play is the lane its job was in when the claim was made, not the one it has now: a finished job
// that is retagged or renamed later must not change what the engine's record says. The claim saved the job's
// title and tags on itself when it was made (job_at_claim, lib/task-db.js claimTask), and that is what the lane is
// read from. A claim without it (made before it was saved) has no lane that anyone can vouch for: it counts at the
// outside-lane weight on the landed side and the missed side alike, and is never rebuilt from the job's notes or
// later events.

function claimedLane(claim) {
  const job = claim && typeof claim === 'object' ? claim.job_at_claim : null;
  if (!job || typeof job !== 'object' || Array.isArray(job) || typeof job.title !== 'string') return null;
  return laneTokens({ title: job.title, tag: job.tag, metadata: { tags: job.tags, todo_tags: job.todo_tags } });
}

function chunksOf(list, size = 400) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

// What the picker reads from the store beside the rating's plays, in one read-only pass:
//   claims    by claim event id: what the claim saved (the whole claimed payload) and where it sits in its job's history
//   handIns   by job: the hand-ins that name who handed the work in and who else built it, in the order they were made
//   records   every landing record in the whole store that names a commit, in the order they were recorded (by the
//             record's own time, and by the order they were inserted in where the time is the same): every workspace
//             that shares the store, and every review pass of a job. Each says which claim it was made under
//             (claim_id), read the way the rating reads it: the latest claim of its job before the record, or
//             `<job>:before` when there is none. The rating keeps one landing per claim, and one workspace, so its
//             plays cannot say which claim recorded a commit first. Read in one query, and only when a landing is to
//             be judged (`records: true`).
// A store that cannot be read throws.
function readFacts({ claimIds, taskIds, records: wantRecords = false, dbPath }) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const marks = (chunk) => chunk.map(() => '?').join(',');
    const claims = new Map();
    for (const chunk of chunksOf(unique(claimIds))) {
      for (const row of db.prepare(`SELECT event_id, version, payload FROM task_events WHERE event_type = 'claimed' AND event_id IN (${marks(chunk)})`).all(...chunk)) {
        claims.set(row.event_id, { version: Number(row.version), payload: parseJson(row.payload) });
      }
    }
    const handIns = new Map();
    for (const chunk of chunksOf(unique(taskIds))) {
      const rows = db.prepare(`SELECT task_id, version, payload FROM task_events WHERE event_type = 'proof_ready' AND task_id IN (${marks(chunk)}) AND (payload LIKE '%handed_in_by%' OR payload LIKE '%built_with%')`).all(...chunk);
      for (const row of rows) {
        const body = parseJson(row.payload);
        if (!body || typeof body !== 'object') continue;
        const engineOf = (name) => {
          const actor = typeof name === 'string' ? normalizeActor(name) : '';
          return actor.startsWith('fleet-') ? actor : '';
        };
        const hand = { version: Number(row.version), by: engineOf(body.handed_in_by), builtWith: unique((Array.isArray(body.built_with) ? body.built_with : []).map(engineOf)) };
        if (!handIns.has(row.task_id)) handIns.set(row.task_id, []);
        handIns.get(row.task_id).push(hand);
      }
    }
    const records = [];
    if (wantRecords) {
      const scan = db.prepare(`SELECT event_id, task_id, version, event_type, payload FROM task_events
        WHERE event_type IN ('proof_ready', 'landing', 'completed') AND (payload LIKE '%merge_commit%' OR payload LIKE '%merge_sha%')
        ORDER BY created_at, rowid`);
      for (const row of scan.iterate ? scan.iterate() : scan.all()) {
        const body = parseJson(row.payload);
        if (!isLandingRecord(row.event_type, body)) continue;
        const commits = commitsOf(body);
        if (commits.length) records.push({ event_id: row.event_id, task_id: row.task_id, version: Number(row.version), commits, claim_id: '' });
      }
      // The claim each record was made under: the job's latest claim before it, by version (gm-season playEventsSql).
      // Read for the jobs that have a record, on the job index, so it grows with the records and not with the store.
      const claimsOf = new Map();
      for (const chunk of chunksOf(unique(records.map((record) => record.task_id)))) {
        for (const row of db.prepare(`SELECT task_id, version, event_id FROM task_events WHERE event_type = 'claimed' AND task_id IN (${marks(chunk)})`).all(...chunk)) {
          if (!claimsOf.has(row.task_id)) claimsOf.set(row.task_id, []);
          claimsOf.get(row.task_id).push({ version: Number(row.version), event_id: row.event_id });
        }
      }
      for (const record of records) {
        let made = null;
        for (const claim of claimsOf.get(record.task_id) || []) {
          if (claim.version < record.version && (!made || claim.version > made.version)) made = claim;
        }
        record.claim_id = made ? made.event_id : `${record.task_id}:before`;
      }
    }
    return { claims, handIns, records };
  } finally {
    try { db.close(); } catch { /* closed */ }
  }
}

// The spellings of a commit worth asking git about: the ones our landings name, and those of any other record that
// could name the same commit (one spelling is the start of the other). A record that cannot is no rival for any of
// them, so git is never asked to read it, and the questions grow with the landings being judged, not with the store.
function relatedSpellings(ours, records) {
  const byStart = new Map();
  for (const name of ours) {
    const key = name.slice(0, 7);
    if (!byStart.has(key)) byStart.set(key, []);
    byStart.get(key).push(name);
  }
  const wanted = new Set(ours);
  for (const record of records) {
    for (const name of record.commits) {
      if ((byStart.get(name.slice(0, 7)) || []).some((mine) => mine.startsWith(name) || name.startsWith(mine))) wanted.add(name);
    }
  }
  return [...wanted];
}

// The engine a landing pays. The rating credits the claim holder, and the rating's own display stays that way. A
// flight whose engine died hands the retry in under the engine that finished it (handed_in_by), with the engines
// that ran before it named beside it (built_with), so the last hand-in made under this claim and before this landing
// says who finished. When no engine is named as the one that finished, the landing pays the claim holder, unless the
// hand-in names another engine beside it: then nobody can say who finished, and it counts for no engine ('').
function finisherOf(play, record, facts) {
  const holder = normalizeActor(play.member);
  const claim = facts.claims.get(play.claim_id);
  const from = claim ? claim.version : 0;
  let last = null;
  for (const handIn of facts.handIns.get(play.task_id) || []) {
    if (handIn.version > from && handIn.version <= record.version && (!last || handIn.version > last.version)) last = handIn;
  }
  if (last && last.by) return last.by;
  const named = new Set([holder, ...(last ? last.builtWith : [])]);
  return named.size > 1 ? '' : holder;
}

// Every fleet engine play since `since`, as the rating builds them (gm-season loadOutcomes, the plays of
// loadSeason without the board around them), each with its lane at the claim. Returns { plays, notes, cannot }.
//
// A landing counts only when it belongs to its job (lib/landing-check.js): its commit is on origin's default branch,
// is no older than its claim (five minutes of clock skew allowed), and no other job recorded the same commit first,
// judged on every landing record in the store (readFacts). It pays the engine that finished it (finisherOf). Misses
// stay as they are. The folder is judged in this order:
//   One. No git, no origin, or no origin/HEAD for this folder: no landing can be checked, whatever is on record. `cannot`
//        says why and `plays` is empty, so the jobs are dealt in turn with one line.
//   Two. An engine's own landing is on record: origin's default branch is fetched once, so a merge from a minute ago is
//        known. A fetch that fails is the same case as One. One that works checks the landings, every commit in one
//        batched git call, and the plays steer.
//   Three. Only misses are on record: they steer by themselves, without a fetch. A newcomer is tried and the engine
//        that missed gets fewer jobs.
// `notes` are plain sentences the flight says once. No task store, or one with no history, is no plays. A store that
// cannot be read throws.
function loadPlays(root, { since, now = Date.now(), dbPath, landing } = {}) {
  const taskDb = require('./task-db');
  const start = Number.isFinite(since) ? since : steeringStart().ms;
  const workspace = taskDb.workspaceRoot(root);
  const days = Math.max(1, Math.ceil((now - start) / DAY_MS));
  const season = require('./gm-season').loadOutcomes(workspace, { now, days, dbPath });
  if (season.error) throw new Error(season.error);
  const mine = (season.outcomes || []).filter((play) => normalizeActor(play.member).startsWith('fleet-')
    && play.claimed_at != null && Number(play.claimed_at) >= start);
  if (!mine.length) return { plays: [], notes: [], cannot: '' };

  const landings = mine.filter((play) => play.kind === 'landed');
  const check = landing || createLandingCheck(workspace, landings.length ? { since: Math.min(...landings.map((play) => Number(play.claimed_at))) } : {});
  const notes = () => (typeof check.notes === 'function' ? check.notes() : []);

  // One. Can any landing be checked in this folder? Asked even when only misses are on record, so a folder that
  //      cannot be checked deals in turn whatever the plays are.
  // Two. An engine's own landing needs origin brought up to date, once.
  let cannot = check.cannotCheck();
  if (!cannot && landings.length) cannot = check.refresh();
  if (cannot) return { plays: [], notes: notes(), cannot };

  const facts = readFacts({
    claimIds: mine.map((play) => play.claim_id),
    taskIds: landings.map((play) => play.task_id),
    records: landings.length > 0,
    dbPath: dbPath || taskDb.getDbPath(),
  });
  const withLane = (play) => ({ ...play, lane: claimedLane((facts.claims.get(play.claim_id) || {}).payload) });
  // Three. Only misses: they steer by themselves.
  if (!landings.length) return { plays: mine.map(withLane), notes: notes(), cannot: '' };

  // The first claim to record each commit keeps it, and no claim after it gets it again: not a later claim on the same
  // job (reopened, claimed again by the same engine or another) and not another job's. A short spelling is read to the
  // commit it starts, so the same commit under two spellings is one commit.
  const byEvent = new Map(facts.records.map((record) => [record.event_id, record]));
  const ours = unique(landings.flatMap((play) => (byEvent.get(play.event_id) || { commits: [] }).commits));
  const seen = check.read(relatedSpellings(ours, facts.records));
  const first = new Map();
  for (const record of facts.records) {
    for (const name of record.commits) {
      const sighting = seen.get(name);
      if (sighting && !first.has(sighting.oid)) first.set(sighting.oid, record.claim_id);
    }
  }

  const plays = [];
  for (const play of mine) {
    if (play.kind !== 'landed') {
      plays.push(withLane(play));
      continue;
    }
    const record = byEvent.get(play.event_id);
    if (!record) continue;
    const member = finisherOf(play, record, facts);
    if (!member) continue;
    const counts = check.landed(record.commits, {
      claimedAt: Number(play.claimed_at),
      owns: (oid) => !first.has(oid) || first.get(oid) === record.claim_id,
    });
    if (counts) plays.push(withLane({ ...play, member }));
  }
  // Git can stop answering partway. What was judged before that is not a verdict: nothing counts.
  cannot = check.cannotCheck();
  if (cannot) return { plays: [], notes: notes(), cannot };
  return { plays, notes: notes(), cannot: '' };
}

// ---------------------------------------------------------------------------
// Explicit choices, and engines that are resting.

function rowId(task) {
  return String((task && (task.id || task.display_id)) || '');
}

function assigneeOf(task) {
  const assigned = task && task.metadata && task.metadata.assigned_to;
  return typeof assigned === 'string' ? assigned.trim() : '';
}

// The engine a job names for itself, if it does, spelled the way the fleet spells its engines.
function namedEngine(task) {
  const raw = task && (task.executed_by || (task.metadata && (task.metadata.executed_by || task.metadata.engine)));
  const name = String(raw || '').trim().toLowerCase();
  if (name === 'cursor-agent' || name === 'cursor agent') return 'cursor';
  if (name === 'claude-code') return 'claude';
  return name;
}

// What a job's own words choose, as the pick reads them: the member it is assigned to and the engine it names, both
// spelled the way the pick spells them. A job read from the task list and the same job read from the store (its
// metadata parsed) give the same answer when nobody has changed them.
function choiceOf(task) {
  return { member: assigneeOf(task), engine: namedEngine(task) };
}

const sameChoice = (a, b) => a.member === b.member && a.engine === b.engine;

// The one line for a job the flight cannot give its choice to, said once however many times it is asked about.
const leftOutNote = (task, why) => `left out ${String((task && (task.display_id || task.id)) || 'a job')}: ${why}`;

// Why a claim was refused when the job's words changed after the pick (the reason claimTask answers with).
const CHOICE_CHANGED = 'choice_changed';

// Why an engine should not be picked right now, or ''. Only a state the registry knows is read: an engine it
// has no entry for is left alone, and an engine out of credit stays out until a person says otherwise.
function restingWhy(entry, now) {
  const { engineReadyAt } = require('./engine-registry');
  const status = entry && entry.health && entry.health.status;
  if (status === 'credit_out') return 'out of credit';
  if (status === 'cooling' && !engineReadyAt(entry, new Date(now))) return 'cooling';
  if (status === 'error' && !engineReadyAt(entry, new Date(now))) return 'failed recently';
  return '';
}

function restingEngines(names, root, now) {
  let view = [];
  try {
    view = require('./engine-registry').readEngineRegistry(root, { persist: false }).engines || [];
  } catch {
    return [];
  }
  const resting = [];
  for (const name of names) {
    const why = restingWhy(view.find((entry) => entry.id === name), now);
    if (why) resting.push({ name, why });
  }
  return resting;
}

// The program a launch runs: its last path segment, so "/opt/bin/claude" and "claude.exe" are both claude.
function programOf(bin) {
  return String(bin || '').split(/[\\/]/).pop().replace(/\.exe$/i, '').toLowerCase();
}

// The engines the Claude spend guard would stop in an unattended run, with a few plain words each. The hook that
// `atris spend guard install` adds stays the real guard on every unattended claude run; this only avoids picking an
// engine that would be refused, so wherever it is unsure it leaves claude out. Two environments are in play, and
// they are not always the same one.
//   launchEnv   where the launch is built. It decides the program and the --model the command carries, through the
//               resolver the fleet builds its commands with (lib/runner-command.js launchFor): the legacy
//               ATRIS_CLAUDE_MODEL, a runner profile, and the runner's own fall back to the cheap model all count.
//   workerEnv   where the worker runs. It decides the guard's verdict, because that is what the guard's hook reads:
//               a sealed one-lap worker has no spend approval, no pay-per-use key and no model variable, whatever
//               the launching side has.
// The rule, and it guesses nothing:
//   - The fleet's own launch is judged by the --model the fleet itself passes, resolved through
//     ANTHROPIC_DEFAULT_*_MODEL in workerEnv. With no --model, by ANTHROPIC_MODEL in workerEnv, else the paid default.
//     No settings file is read, from any home (unattendedStop).
//   - A launch template somebody wrote is never read for its model (launch.custom). It counts as a model nobody can
//     tell, which counts as possibly paid: the engine sits out unless ATRIS_CLAUDE_SPEND_OK in workerEnv covers the
//     paid default, and the line says the model could not be told.
// Only a launch of the claude program is asked. A launch that cannot be worked out leaves the engine alone.
const CANNOT_TELL = 'could not tell which model its custom launch template uses, so it counts as paid, and there is no spend approval';

function spendStops(names, launchEnv, workerEnv) {
  const { launchFor } = require('./runner-command');
  const stops = [];
  for (const name of names) {
    try {
      const launch = launchFor(name, { env: launchEnv });
      if (!launch || programOf(launch.bin) !== 'claude') continue;
      // A model nobody can tell is asked about as the paid default, never as a model the worker's environment names.
      const stop = unattendedStop({ model: launch.custom ? 'default' : launch.model, env: workerEnv });
      if (stop) stops.push({ name, why: launch.custom && stop.reason === 'paid_model' ? CANNOT_TELL : stop.why });
    } catch {
      // an engine whose launch cannot be worked out is left alone
    }
  }
  return stops;
}

// ---------------------------------------------------------------------------
// One flight's steering.

// Steering for one flight. Nothing is read until a job needs a pick, and when steering is off nothing is ever
// read. `plays` stands in for the task store (tests). `env` is the environment the launches are built in. `workerEnv`
// is the environment the workers will run in when it is not the same one (a sealed one-lap worker is given far
// less); the Claude spend guard's verdict is given for it. `named` says the caller named the engines: a list a
// caller names is never filtered, on the first pick or on a retry. The pieces the flights use:
//   rest(names)           which of these engines are ready to be picked, and a note naming those left out
//   deal(entries, roster) the fleet's turns, steered: explicit choices first, then an engine for every other job
//   next(job, candidates) the best of these for one job's retry, or null when today's rule stands
//   notes()               what steering has to say that nobody has printed yet (deal already hands over its own)
//   gives(roster)         a test for staffing: false for a job whose chosen engine this roster cannot give, which is
//                         then left out (with its line) before it can take a slot or hold another job's files
//   guardClaim(task)      the check a claim makes on a job this flight picked for, inside the claim's own transaction
function startSteering({ root = process.cwd(), pick, env = process.env, workerEnv = env, now = Date.now(), plays = null, named = false } = {}) {
  const on = pickMode(pick, env) === 'rating';
  const since = steeringStart(env);
  const header = `steering on since ${since.label}`;
  let loaded = null;
  const pending = [];
  const told = new Set();
  // Each note is said once per flight, however many jobs or retries meet it.
  const tell = (note) => {
    if (note && !told.has(note)) {
      told.add(note);
      pending.push(note);
    }
  };
  // The results, read once. When no landing can be checked in this folder, `cannot` says why and the line that says
  // so is told here, whoever reads the results first (the first pick or a retry): the jobs are dealt in turn.
  const history = () => {
    if (!loaded) {
      try {
        const got = plays ? { plays, notes: [], cannot: '' } : loadPlays(root, { since: since.ms, now });
        loaded = { plays: got.plays, error: '', cannot: got.cannot || '' };
        if (loaded.cannot) tell(`${header}: dealing in turn: landings cannot be checked here (${loaded.cannot})`);
        for (const note of got.notes) tell(`${header}: ${note}`);
      } catch (err) {
        loaded = { plays: [], error: String(err && err.message || err).split('\n')[0].slice(0, 120), cannot: '' };
      }
    }
    return loaded;
  };

  // Which of these engines are ready to be picked: not resting, and not one the spend guard would stop. Always
  // asks. `rest` is the same question for a caller that may have named its engines.
  function screen(names) {
    const list = unique(names);
    if (!on) return { ready: list, resting: [], note: '' };
    const resting = restingEngines(list, root, now);
    for (const stop of spendStops(list, env, workerEnv)) {
      if (!resting.some((entry) => entry.name === stop.name)) resting.push(stop);
    }
    const ready = list.filter((name) => !resting.some((entry) => entry.name === name));
    return {
      ready,
      resting,
      note: resting.length ? `left out, not ready: ${resting.map((entry) => `${entry.name} (${entry.why})`).join(', ')}` : '',
    };
  }

  // A list the caller named is never filtered: everything on it stays, whatever state the engine is in.
  function rest(names) {
    return named ? { ready: unique(names), resting: [], note: '' } : screen(names);
  }

  // The engine of a member, when the roster decided it. Asked once per member. This is the resolver every member
  // command uses (lib/member-engine.js memberRosterEngine, called as they call it), so the job follows the roster
  // exactly as `atris member` does, including the engine it falls back to when the member's own is out of credit.
  const memberEngines = new Map();
  function memberEngine(member) {
    if (!memberEngines.has(member)) {
      let id = '';
      try {
        const own = require('./member-engine').memberRosterEngine(member, root);
        id = own && own.engine && own.engine.id ? String(own.engine.id) : '';
      } catch {
        id = '';
      }
      memberEngines.set(member, id);
    }
    return memberEngines.get(member);
  }

  // What a job's own words choose, judged against the whole roster before anything is filtered out. Null when the
  // job chooses nothing. Otherwise one of:
  //   { engine }   the engine the job goes to. It is '' for a member the roster does not decide, and then the job
  //                keeps the engine the turns gave it, which is all there is to give.
  //   { out }      the job is left out of the flight, and this is why in plain words: the person chose an engine, or a
  //                member whose roster engine is one, that this flight does not have. Nothing else may take their place.
  // The engine a job names decides: it goes there when the flight has it, and an owner's name (a member) stands for
  // the engine its roster gives it. A job that names nothing goes to the engine of the member it is assigned to.
  function explicitChoice(task, full) {
    const namedBy = namedEngine(task);
    const assignee = assigneeOf(task);
    if (!namedBy && !assignee) return null;
    const pool = `(${full.join(', ')})`;
    if (namedBy) {
      if (full.includes(namedBy)) return { engine: namedBy };
      const own = memberEngine(namedBy);
      if (own && full.includes(own)) return { engine: own };
      return { out: own ? `it names ${namedBy}, whose engine is ${own}, which this flight does not have ${pool}` : `it names ${namedBy}, which this flight does not have ${pool}` };
    }
    const own = memberEngine(assignee);
    if (!own) return { engine: '' };
    if (full.includes(own)) return { engine: own };
    return { out: `it is assigned to ${assignee}, whose engine is ${own}, which this flight does not have ${pool}` };
  }

  // The fleet's turns, steered. `entries` are the jobs with the engine the turns gave each over the whole
  // `roster`. Explicit choices are resolved first, before any filter or early return: a job that names its
  // engine goes there, a job assigned to a member goes to that member's own engine, and a choice the roster
  // cannot decide (a member it has no engine for) keeps the engine the turns gave it (unless that engine is
  // resting or stopped, and then the job is picked like any other). A choice the flight cannot give at all,
  // an engine or a member's engine that is not in the roster, is never given to someone else: the job is left out
  // of this flight, with one line naming it and why. Resting and spend-stopped engines are left out of the pool
  // after that, and only for the jobs nobody chose for. `filter: false` keeps every roster engine in the pool, and
  // it is the default for a list the caller named.
  // Returns { entries, ready, notes, picked }: ready is the pool, notes are plain sentences to print, and entries
  // are the jobs that stay, each with the engine the turns or the pick gave it (a job left out is not in it).
  function deal(entries, roster, { filter = !named } = {}) {
    const list = Array.isArray(entries) ? entries : [];
    if (!on) return { entries: list, ready: Array.isArray(roster) ? roster : [], notes: [], picked: 0 };
    const full = unique(roster);
    const sitOut = filter ? screen(full) : { ready: full, note: '' };
    tell(sitOut.note);
    const ready = sitOut.ready;

    const used = new Map(ready.map((name) => [name, 0]));
    const dealt = new Array(list.length).fill(null);
    const leftOut = new Set();
    list.forEach((entry, i) => {
      const choice = explicitChoice(entry && entry.task, full);
      if (!choice) return;
      if (choice.out) {
        leftOut.add(i);
        tell(leftOutNote(entry && entry.task, choice.out));
        return;
      }
      // A choice the roster cannot decide leaves the job on its turn, which is exactly what the turns would do,
      // unless that engine cannot be used right now. Then nobody has chosen for this job after all.
      if (!choice.engine && !ready.includes(entry.engine)) return;
      const engine = choice.engine || entry.engine;
      if (used.has(engine)) used.set(engine, used.get(engine) + 1);
      dealt[i] = engine === entry.engine ? entry : { ...entry, engine };
    });

    const free = list.map((entry, i) => i).filter((i) => !dealt[i] && !leftOut.has(i));
    let picked = 0;
    const turn = (i) => ({ ...list[i], engine: ready[i % ready.length] });
    if (free.length && ready.length) {
      const known = ready.length >= 2 ? history() : null;
      if (!known) {
        // One engine is ready: nothing to choose between.
        free.forEach((i) => { dealt[i] = turn(i); });
      } else if (known.error) {
        tell(`${header}: could not read results (${known.error}), so jobs are dealt in turn`);
        free.forEach((i) => { dealt[i] = turn(i); });
      } else if (known.cannot) {
        // history() has said why. Nothing that landed can be told from nothing here, so no engine is ahead.
        free.forEach((i) => { dealt[i] = turn(i); });
      } else if (!haveResults(known.plays, ready, since.ms)) {
        tell(`${header}: no results yet, so jobs are dealt in turn`);
        free.forEach((i) => { dealt[i] = turn(i); });
      } else {
        // The share is a spread, not a capacity limit. It keeps one engine from taking a whole flight while the
        // others sit idle: the draw still orders every candidate, and the job goes to the first with room.
        // Explicit choices count against it but are never refused by it, and when every engine is full the
        // draw's own order stands. A job left out is not dealt to anyone, so it counts toward nobody's share.
        const share = Math.ceil((list.length - leftOut.size) / ready.length);
        free.forEach((i) => {
          const task = list[i] && list[i].task;
          const id = rowId(task);
          const result = pickBuilders({
            candidates: ready,
            job: { id, lane: laneTokens(task) },
            plays: known.plays,
            since: since.ms,
            seed: pickSeed(id, now),
            full: ready.filter((name) => used.get(name) >= share),
          });
          used.set(result.picked, used.get(result.picked) + 1);
          picked += 1;
          dealt[i] = { ...list[i], engine: result.picked, pick: result.line };
        });
      }
    }
    return { entries: dealt.filter(Boolean), ready, notes: notes(), picked };
  }

  // The jobs a flight may staff, asked before it is staffed. A job whose own words choose an engine this roster
  // cannot give (an engine it names, or the engine of the member it is assigned to, that the roster does not have) is
  // left out, with the same line deal says, and is never given to someone else. Asked of each job the staffing looks at,
  // in order, so a job that cannot go takes no slot and holds no file or blind place against the jobs after it. A job
  // that chooses nothing, or something the roster can give, may be staffed. When steering is off, or the roster is empty,
  // every job may.
  function gives(roster) {
    const full = unique(roster);
    // A roster with no engine has nothing to give anyone and nobody to staff: no job is named as left out for it.
    if (!on || !full.length) return () => true;
    return (task) => {
      const choice = explicitChoice(task, full);
      if (!choice || !choice.out) return true;
      tell(leftOutNote(task, choice.out));
      return false;
    };
  }

  // The check a claim makes, inside its own transaction, on a job this flight picked an engine for. The pick went on
  // who the job is assigned to and the engine it names, as the task list showed them; the claim comes later, and the
  // job may have been given to someone else, or named another engine, in between. The returned function is asked
  // with the job as it stands in the store when the claim is made, and answers with the reason to refuse (a job whose
  // words changed is not claimed for the old choice) or ''. Null when steering is off: the turns went on neither.
  function guardClaim(task) {
    if (!on) return null;
    const used = choiceOf(task);
    return (current) => (sameChoice(used, choiceOf(current)) ? '' : CHOICE_CHANGED);
  }

  // The best of these candidates for one job's retry on another engine, with the line that says why. Null
  // when steering is off or has no result to go on (or no landing can be checked here): then today's rule stands.
  function next(job, candidates) {
    if (!on) return null;
    const names = unique(candidates);
    if (!names.length) return null;
    const known = history();
    if (known.error || known.cannot || !haveResults(known.plays, names, since.ms)) return null;
    const id = rowId(job);
    const result = pickBuilders({ candidates: names, job: { id, lane: laneTokens(job) }, plays: known.plays, since: since.ms, seed: pickSeed(id, now) });
    return result.picked ? { engine: result.picked, pick: result.line } : null;
  }

  // The notes steering has to say that nobody has printed yet. Call after next(): reading the results for the
  // first time is when a landing problem comes to light.
  const notes = () => pending.splice(0);

  return { on, since, rest, deal, next, notes, gives, guardClaim };
}

// ---------------------------------------------------------------------------
// atris rating: how many jobs steering has picked, counted from the flights' receipts.

function pickedJobs(receipt) {
  const jobs = new Set();
  for (const row of Array.isArray(receipt.staffed) ? receipt.staffed : []) {
    if (row && row.pick) jobs.add(String(row.task));
  }
  for (const row of Array.isArray(receipt.results) ? receipt.results : []) {
    if (row && row.restaffed && row.restaffed.pick) jobs.add(String(row.task));
  }
  return jobs.size;
}

function countPicked(root, sinceMs) {
  const dir = path.join(root, 'atris', 'runs');
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  let total = 0;
  for (const name of names) {
    if (!/^(fleet|dispatch)-.*\.json$/.test(name)) continue;
    const file = path.join(dir, name);
    let receipt;
    try {
      if (fs.statSync(file).mtimeMs < sinceMs) continue;
      receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    if (!receipt || !(Date.parse(receipt.at) >= sinceMs)) continue;
    total += pickedJobs(receipt);
  }
  return total;
}

// What `atris rating` says about steering: nothing but { on: false } when it is off, else the start, the jobs
// it has picked since, and the one line. A job counts once per flight, however many times it was picked.
function steeringSummary({ root = process.cwd(), env = process.env } = {}) {
  if (pickMode(undefined, env) !== 'rating') return { on: false };
  const since = steeringStart(env);
  const picked = countPicked(root, since.ms);
  return {
    on: true,
    since: since.iso,
    picked,
    line: `steering on since ${since.label}: picked ${picked} ${picked === 1 ? 'job' : 'jobs'}`,
  };
}

module.exports = {
  CHOICE_CHANGED,
  STEERING_START,
  steeringStart,
  parsePickFlag,
  pickMode,
  pickSeed,
  laneTokens,
  pickBuilders,
  loadPlays,
  startSteering,
  steeringSummary,
};
