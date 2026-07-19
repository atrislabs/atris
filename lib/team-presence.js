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
  const members = [...candidates.entries()]
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

  return {
    schema: 'atris.team_presence.v1',
    generated_at: new Date(nowMs).toISOString(),
    freshness_window_seconds: Math.round(freshnessWindowMs / 1000),
    totals: {
      awake: members.length,
      waiting_operator: Math.max(0, Number(stream.waiting_operator) || 0),
      landing_wait: Math.max(0, Number(stream.landing_wait) || 0),
    },
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

module.exports = {
  ACTIVE_MISSION_STATES,
  ACTIVE_TASK_STATES,
  DEFAULT_FRESHNESS_WINDOW_MS,
  buildTeamPresence,
  operatorSentence,
  renderTeamPresence,
};
