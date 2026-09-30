'use strict';

const DEFAULT_FRESHNESS_WINDOW_MS = 15 * 60 * 1000;
const ACTIVE_TASK_STATES = new Set(['claimed', 'do', 'doing', 'in_progress', 'review']);
const ACTIVE_MISSION_STATES = new Set(['planning', 'active', 'running', 'ready']);

function timestampMs(value) {
  if (value == null || value === '') return 0;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return 0;
    return value > 1000000000000 ? value : value * 1000;
  }
  const numeric = Number(value);
  if (Number.isFinite(numeric) && String(value).trim() !== '') return timestampMs(numeric);
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function latestTimestamp(...values) {
  return values.reduce((latest, value) => Math.max(latest, timestampMs(value)), 0);
}

function isoTimestamp(value) {
  const ms = timestampMs(value);
  return ms ? new Date(ms).toISOString() : null;
}

function memberName(value) {
  let text = String(value || '').trim();
  if (!text) return '';
  if (text.includes('/')) text = text.split('/')[0];
  text = text.replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!text || /^(team|unknown)$/i.test(text)) return '';
  return text.slice(0, 32);
}

function operatorSentence(value, fallback = 'current activity was recorded') {
  let text = String(value || '')
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^[-*]\s+/, ''))
    .find(Boolean) || fallback;
  text = text
    .replace(/(^|\s)--[a-z0-9][a-z0-9-]*(?:=[^\s]+)?/ig, '$1')
    .replace(/\b[0-9A-HJKMNP-TV-Z]{20,26}\b/g, 'the item')
    .replace(/\b[A-Z]{2,12}-\d+\b/gi, 'the task')
    .replace(/\bmission-[a-z0-9][a-z0-9-]{8,}\b/ig, 'the mission')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) text = fallback;
  if (text.length > 180) text = `${text.slice(0, 177).trim()}...`;
  if (!/[.!?]$/.test(text)) text += '.';
  return text;
}

function taskOwner(task) {
  return task && (task.claimed_by || task.assigned_to || task.metadata?.assigned_to) || '';
}

function taskActivityMs(task) {
  const events = Array.isArray(task?.events) ? task.events : [];
  return latestTimestamp(
    task?.updated_at,
    task?.created_at,
    ...events.map((event) => event && event.created_at),
  );
}

function missionActivityMs(mission) {
  return latestTimestamp(
    mission?.last_tick_at,
    mission?.last_tick?.finished_at,
    mission?.last_tick?.at,
    mission?.updated_at,
    mission?.created_at,
  );
}

function activityOrder(a, b, activityFn) {
  return activityFn(b) - activityFn(a)
    || String(a.id || a.title || a.objective || '').localeCompare(String(b.id || b.title || b.objective || ''));
}

function taskRows(input) {
  if (Array.isArray(input.tasks)) return input.tasks;
  if (Array.isArray(input.taskStatus?.tasks)) return input.taskStatus.tasks;
  if (Array.isArray(input.taskStatus?.streams)) {
    return input.taskStatus.streams.flatMap((stream) => Array.isArray(stream.tasks) ? stream.tasks : []);
  }
  return [input.taskStatus?.current].filter(Boolean);
}

function missionRows(input) {
  if (Array.isArray(input.missions)) return input.missions;
  if (Array.isArray(input.missionStatus?.missions)) return input.missionStatus.missions;
  return [];
}

function loopMissionName(mission) {
  const raw = mission?.name || mission?.title || mission?.objective || mission?.id || 'mission';
  return operatorSentence(raw, 'mission').replace(/[.!?]+$/, '').slice(0, 90);
}

function loopForMission(mission) {
  if (!mission) return null;
  const lastTick = isoTimestamp(
    mission.last_tick_at
      || mission.last_tick?.finished_at
      || mission.last_tick?.at,
  );
  return {
    mission: loopMissionName(mission),
    cadence: String(mission.cadence || 'manual'),
    runner: String(mission.runner || mission.executed_by || 'manual'),
    last_tick: lastTick || 'never',
  };
}

function streamActiveRows(stream) {
  return (Array.isArray(stream?.active) ? stream.active : []).map((row) => {
    if (Array.isArray(row)) return { name: row[0], summary: row[1], last_seen: row[2] };
    return {
      name: row?.name || row?.agent || row?.member,
      summary: row?.summary || row?.doing || row?.work,
      last_seen: row?.last_seen || row?.ts || row?.at,
    };
  });
}

function buildTeamPresence(input = {}) {
  const nowMs = timestampMs(input.nowMs ?? input.now ?? Date.now()) || Date.now();
  const freshnessWindowMs = Number(input.freshnessWindowMs) > 0
    ? Number(input.freshnessWindowMs)
    : DEFAULT_FRESHNESS_WINDOW_MS;
  const stream = input.stream || input.streamSnapshot || {};
  const events = Array.isArray(input.streamEvents)
    ? input.streamEvents
    : Array.isArray(input.events) ? input.events : [];
  const tasks = taskRows(input).filter(Boolean);
  const missions = missionRows(input).filter(Boolean);
  const candidates = new Map();
  const lastSeen = new Map();
  const summaries = new Map();
  const tasksByMember = new Map();
  const missionsByMember = new Map();

  const keyFor = (value) => memberName(value).toLowerCase();
  const addCandidate = (value) => {
    const name = memberName(value);
    const key = name.toLowerCase();
    if (!key) return '';
    if (!candidates.has(key)) candidates.set(key, name);
    return key;
  };
  const noteSeen = (value, timestamp) => {
    const key = keyFor(value);
    const ms = timestampMs(timestamp);
    if (!key || !ms) return;
    lastSeen.set(key, Math.max(lastSeen.get(key) || 0, ms));
  };

  for (const event of events) {
    noteSeen(event?.agent || event?.member || event?.owner, event?.ms || event?.ts || event?.at || event?.created_at);
  }

  for (const row of streamActiveRows(stream)) {
    const key = addCandidate(row.name);
    if (!key) continue;
    if (row.summary) summaries.set(key, row.summary);
    noteSeen(row.name, row.last_seen);
  }

  for (const task of tasks) {
    if (!ACTIVE_TASK_STATES.has(String(task.status || '').toLowerCase())) continue;
    const owner = taskOwner(task);
    const key = addCandidate(owner);
    if (!key) continue;
    noteSeen(owner, taskActivityMs(task));
    if (!tasksByMember.has(key)) tasksByMember.set(key, []);
    tasksByMember.get(key).push(task);
  }

  for (const mission of missions) {
    if (!ACTIVE_MISSION_STATES.has(String(mission.status || '').toLowerCase())) continue;
    const owner = mission.owner || mission.member;
    const key = addCandidate(owner);
    if (!key) continue;
    noteSeen(owner, missionActivityMs(mission));
    if (!missionsByMember.has(key)) missionsByMember.set(key, []);
    missionsByMember.get(key).push(mission);
  }

  for (const rows of tasksByMember.values()) rows.sort((a, b) => activityOrder(a, b, taskActivityMs));
  for (const rows of missionsByMember.values()) rows.sort((a, b) => activityOrder(a, b, missionActivityMs));

  const cutoffMs = nowMs - freshnessWindowMs;
  const activePeople = [...candidates.entries()]
    .sort((a, b) => a[1].localeCompare(b[1]))
    .flatMap(([key, name]) => {
      const seenMs = lastSeen.get(key) || 0;
      if (seenMs < cutoffMs) return [];
      const task = tasksByMember.get(key)?.[0] || null;
      const mission = missionsByMember.get(key)?.[0] || null;
      const doing = summaries.get(key)
        || task?.title
        || mission?.next_action
        || mission?.objective;
      return [{
        name,
        awake: true,
        doing: operatorSentence(doing),
        loop: loopForMission(mission),
        last_seen: new Date(seenMs).toISOString(),
      }];
    });
  const operatorKey = keyFor(input.operator || 'operator');
  const operator = activePeople.find((person) => keyFor(person.name) === operatorKey) || null;
  const members = activePeople.filter((person) => keyFor(person.name) !== operatorKey);

  return {
    schema: 'atris.team_presence.v1',
    generated_at: new Date(nowMs).toISOString(),
    freshness_window_seconds: Math.round(freshnessWindowMs / 1000),
    totals: {
      awake: members.length,
      waiting_operator: Math.max(0, Number(stream.waiting_operator) || 0),
      landing_wait: Math.max(0, Number(stream.landing_wait) || 0),
    },
    operator,
    members,
  };
}

function renderTeamPresence(presence) {
  const minutes = presence.freshness_window_seconds / 60;
  const windowText = Number.isInteger(minutes) ? `${minutes} minute${minutes === 1 ? '' : 's'}` : `${presence.freshness_window_seconds} seconds`;
  const lines = [
    `team presence: ${presence.totals.awake} awake`,
    `freshness window: ${windowText}`,
    `waiting on operator: ${presence.totals.waiting_operator}`,
    `landing wait: ${presence.totals.landing_wait}`,
  ];
  if (presence.operator) {
    lines.push('operator:');
    lines.push(`  ${presence.operator.name}: ${presence.operator.doing}`);
    if (presence.operator.loop) {
      lines.push(`    loop: ${presence.operator.loop.mission} [${presence.operator.loop.cadence} | ${presence.operator.loop.runner} | last tick ${presence.operator.loop.last_tick}]`);
    }
    lines.push(`    last seen: ${presence.operator.last_seen}`);
  }
  if (!presence.members.length) {
    lines.push('awake roster: empty');
    return lines.join('\n');
  }
  lines.push('awake roster:');
  for (const member of presence.members) {
    lines.push(`  ${member.name}: ${member.doing}`);
    if (member.loop) {
      lines.push(`    loop: ${member.loop.mission} [${member.loop.cadence} | ${member.loop.runner} | last tick ${member.loop.last_tick}]`);
    }
    lines.push(`    last seen: ${member.last_seen}`);
  }
  return lines.join('\n');
}

// --- who really worked this week ------------------------------------------
//
// "Awake" above is a 15-minute window. A member that did real work yesterday
// is not awake, but it is active. Activity reads evidence that already sits
// on disk: dated files in atris/team/<member>/logs/, commits that name the
// member, runs the roster recorded for the member, and the same stream
// events presence reads (task claims, mission receipts, worktree commits),
// over a wider window. Each piece of evidence counts as one run on its day.
// A member with evidence in the last 7 days is active; 8 to 14 days is
// quiet; nothing in 14 days is idle.

const DAY_MS = 24 * 60 * 60 * 1000;
const ACTIVE_DAYS = 7;
const IDLE_AFTER_DAYS = 14;
const FAILED_RUN_OUTCOMES = new Set(['failed', 'stalled', 'credit out']);

function localDay(ms) {
  const date = new Date(ms);
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// The first real YYYY-MM-DD in a log file name, as a local day ('' if none).
function logFileDay(name) {
  const match = /(\d{4})-(\d{2})-(\d{2})/.exec(String(name || ''));
  if (!match) return '';
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return '';
  return match[0];
}

// `git log --format=%x1e%aI%x1f%B` output, read once for the whole team.
function parseGitLog(text) {
  return String(text || '').split('\x1e').map((chunk) => {
    const [at, ...rest] = chunk.split('\x1f');
    const message = rest.join('\x1f').trim();
    const ms = timestampMs(String(at || '').trim());
    if (!ms || !message) return null;
    const [subject, ...body] = message.split(/\r?\n/);
    return { ms, subject: subject.trim(), body: body.join('\n') };
  }).filter(Boolean);
}

// Which members a commit names, and whether it is a revert. Plain words are
// not enough: member names like "notes", "sites", and "builder" also show up
// in ordinary messages and in the atris-builder co-author line. A commit
// names a member through a "Member: <name>" or "Atris-Member: <name>"
// trailer, a co-author whose display name is the member, or a subject that
// starts with "<name>:" or "<name>(scope):". A revert names whoever the
// reverted subject named.
function commitMembers(commit, known) {
  const names = new Set();
  const check = (value) => {
    const key = String(value || '').trim().toLowerCase();
    if (key && known.has(key)) names.add(key);
  };
  let subject = String(commit.subject || '');
  const revert = /^revert\s+"(.+)"\s*$/i.exec(subject);
  if (revert) subject = revert[1];
  const prefix = /^([a-z0-9][a-z0-9_.-]*)(?:\([^)]*\))?:\s/i.exec(subject);
  if (prefix) check(prefix[1]);
  for (const line of String(commit.body || '').split(/\r?\n/)) {
    const trailer = /^\s*(?:atris-)?member:\s*([a-z0-9_.-]+)\s*$/i.exec(line);
    if (trailer) check(trailer[1]);
    const coauthor = /^\s*co-authored-by:\s*([^<]+?)\s*</i.exec(line);
    if (coauthor) check(coauthor[1]);
  }
  return { names: [...names], reverted: Boolean(revert) };
}

function emptyDay() {
  return { runs: 0, landed: 0, failed: 0, reverted: 0, engines: {}, models: {} };
}

function topKey(counts) {
  let best = '';
  for (const [key, count] of Object.entries(counts || {})) {
    if (!best || count > counts[best]) best = key;
  }
  return best || null;
}

// One activity row per member, from evidence gathered by the caller:
//   logDays: { member: ['2026-09-28', ...] }
//   commits: parsed git log rows ({ ms, subject, body })
//   runs:    roster run records ({ at, member, engine, model, outcome })
//   events:  stream events ({ agent, ms | ts, summary })
function buildMemberActivity(input = {}) {
  const nowMs = timestampMs(input.nowMs ?? input.now ?? Date.now()) || Date.now();
  const names = [...new Set((input.members || []).map((name) => String(name || '').trim().toLowerCase()).filter(Boolean))];
  const known = new Set(names);
  const today = localDay(nowMs);
  const activeSince = localDay(nowMs - (ACTIVE_DAYS - 1) * DAY_MS);
  const quietSince = localDay(nowMs - (IDLE_AFTER_DAYS - 1) * DAY_MS);
  const byMember = new Map(names.map((name) => [name, { days: {}, last: '', evidence: { logs: 0, commits: 0, runs: 0, events: 0 } }]));
  const note = (member, day, source, apply) => {
    const row = byMember.get(member);
    if (!row || !day || day > today) return;
    if (day > row.last) row.last = day;
    if (day < quietSince) return;
    const bucket = row.days[day] || (row.days[day] = emptyDay());
    bucket.runs += 1;
    row.evidence[source] += 1;
    if (apply) apply(bucket);
  };

  for (const [member, days] of Object.entries(input.logDays || {})) {
    for (const day of days || []) note(String(member).toLowerCase(), logFileDay(day), 'logs');
  }
  for (const commit of input.commits || []) {
    const { names: named, reverted } = commitMembers(commit, known);
    for (const member of named) {
      note(member, localDay(commit.ms), 'commits', (bucket) => {
        if (reverted) bucket.reverted += 1;
        else bucket.landed += 1;
      });
    }
  }
  for (const run of input.runs || []) {
    const member = String(run.member || '').trim().toLowerCase();
    const ms = timestampMs(run.at);
    if (!member || !ms) continue;
    note(member, localDay(ms), 'runs', (bucket) => {
      if (run.outcome === 'landed') bucket.landed += 1;
      else if (FAILED_RUN_OUTCOMES.has(run.outcome)) bucket.failed += 1;
      if (run.engine) bucket.engines[run.engine] = (bucket.engines[run.engine] || 0) + 1;
      if (run.model) bucket.models[`${run.engine || ''}\u0000${run.model}`] = (bucket.models[`${run.engine || ''}\u0000${run.model}`] || 0) + 1;
    });
  }
  // A task or mission shows up as several stream events; one per summary
  // per day counts.
  const seenEvents = new Set();
  for (const event of input.events || []) {
    const member = memberName(event?.agent || event?.member || event?.owner).toLowerCase();
    const ms = timestampMs(event?.ms || event?.ts || event?.at || event?.created_at);
    if (!member || !ms || !known.has(member)) continue;
    const day = localDay(ms);
    const key = `${member}|${day}|${event.summary || event.event || ''}`;
    if (seenEvents.has(key)) continue;
    seenEvents.add(key);
    note(member, day, 'events');
  }

  return names.map((name) => {
    const row = byMember.get(name);
    const week = Object.entries(row.days).filter(([day]) => day >= activeSince);
    const sum = (field) => week.reduce((total, [, bucket]) => total + bucket[field], 0);
    const engines = {};
    const models = {};
    for (const [, bucket] of week) {
      for (const [key, count] of Object.entries(bucket.engines)) engines[key] = (engines[key] || 0) + count;
      for (const [key, count] of Object.entries(bucket.models)) models[key] = (models[key] || 0) + count;
    }
    const engine = topKey(engines);
    const modelKey = topKey(Object.fromEntries(Object.entries(models).filter(([key]) => !engine || key.startsWith(`${engine}\u0000`))));
    const lastMs = row.last ? new Date(`${row.last}T12:00:00`).getTime() : 0;
    const status = row.last >= activeSince ? 'active' : row.last >= quietSince ? 'quiet' : 'idle';
    return {
      name,
      status,
      last_active: row.last || null,
      days_since: row.last ? Math.max(0, Math.round((new Date(`${today}T12:00:00`).getTime() - lastMs) / DAY_MS)) : null,
      runs_7d: sum('runs'),
      engine,
      model: modelKey ? modelKey.split('\u0000')[1] : null,
      landed: sum('landed'),
      failed: sum('failed'),
      reverted: sum('reverted'),
      evidence: row.evidence,
      days: Object.fromEntries(Object.entries(row.days).sort(([a], [b]) => a.localeCompare(b)).map(([day, bucket]) => [day, {
        runs: bucket.runs,
        engine: topKey(bucket.engines),
        model: (topKey(bucket.models) || '').split('\u0000')[1] || null,
        landed: bucket.landed,
        failed: bucket.failed,
        reverted: bucket.reverted,
      }])),
    };
  });
}

// The first local day of the 7-day activity window.
function activeWindowStartDay(nowMs = Date.now()) {
  return localDay((timestampMs(nowMs) || Date.now()) - (ACTIVE_DAYS - 1) * DAY_MS);
}

// One row per member per day with any evidence in the last 7 days, the
// shape the self-improvement loop reads from member_activity.jsonl.
function memberActivityRows(activity, nowMs = Date.now()) {
  const since = activeWindowStartDay(nowMs);
  const rows = [];
  for (const member of activity || []) {
    for (const [day, bucket] of Object.entries(member.days || {})) {
      if (day < since || !bucket.runs) continue;
      rows.push({
        member: member.name,
        day,
        runs: bucket.runs,
        engine: bucket.engine,
        model: bucket.model,
        landed: bucket.landed,
        failed: bucket.failed,
        reverted: bucket.reverted,
      });
    }
  }
  return rows.sort((a, b) => a.day.localeCompare(b.day) || a.member.localeCompare(b.member));
}

module.exports = {
  ACTIVE_MISSION_STATES,
  ACTIVE_TASK_STATES,
  DEFAULT_FRESHNESS_WINDOW_MS,
  IDLE_AFTER_DAYS,
  activeWindowStartDay,
  buildMemberActivity,
  buildTeamPresence,
  commitMembers,
  logFileDay,
  memberActivityRows,
  parseGitLog,
  renderTeamPresence,
};
