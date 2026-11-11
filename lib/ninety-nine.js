'use strict';

const LENGTHS = { focus: [25, 50, 90], meditate: [10, 20, 30] };
const SOURCES = ['cli', 'mac', 'ios'];
const PAUSE_LIMIT_MS = 30 * 60000;
const HEALTH_FIELDS = ['sleep_min', 'steps', 'workout_min', 'mindful_min'];
const OUTCOMES = ['yes', 'partly', 'no'];
const INTENTION_MAX = 200;
const BLOCK_NOTE_MAX = 500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function lineIdentity(record) {
  return `${record.type}|${record.type === 'health_day' ? record.date : record.id}|${record.at}|${record.source}`;
}

function uniqueLines(records) {
  const seen = new Set();
  return records.filter((record) => {
    const key = lineIdentity(record);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function oneLineText(value) {
  return typeof value === 'string' && !/[\r\n\u2028\u2029]/.test(value);
}

function oneLine(value, limit) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit).trim();
}

function validLength(kind, minutes) {
  return Object.hasOwn(LENGTHS, kind) && LENGTHS[kind].includes(minutes);
}

function parseSessionLog(text) {
  return text.split('\n').flatMap((line, index) => {
    if (!line.trim()) return [];
    let record;
    try { record = JSON.parse(line); } catch { /* Report the line below. */ }
    const common = record && record.v === 1 && SOURCES.includes(record.source)
      && typeof record.at === 'string' && Number.isFinite(Date.parse(record.at));
    const session = typeof record?.id === 'string' && record.id;
    const start = record?.type === 'start' && validLength(record.kind, record.planned_min)
      && (record.intention === undefined || oneLineText(record.intention));
    const end = record?.type === 'end' && ['done', 'partial'].includes(record.status)
      && (record.inferred === undefined || typeof record.inferred === 'boolean')
      && (record.note === undefined || oneLineText(record.note))
      && (record.outcome === undefined || record.outcome === null || OUTCOMES.includes(record.outcome));
    const pause = ['pause', 'resume'].includes(record?.type);
    const health = record?.type === 'health_day' && typeof record.date === 'string'
      && /^\d{4}-\d{2}-\d{2}$/.test(record.date)
      && Number.isFinite(Date.parse(record.date))
      && new Date(record.date).toISOString().slice(0, 10) === record.date
      && HEALTH_FIELDS.every((field) => record[field] === undefined
        || (Number.isFinite(record[field]) && record[field] >= 0));
    if (!common || (!health && !(session && (start || end || pause)))) {
      throw new Error(`session log has an invalid record on line ${index + 1}; nothing was written`);
    }
    return [record];
  });
}

// records -> sessions -> overdue ends -> the requested action
function foldSessions(records) {
  const sessions = new Map();
  const events = new Map();
  const ends = new Map();
  const outcomes = new Map();
  // Stable sort preserves append order when timestamps tie, without rewriting the log.
  for (const record of uniqueLines(records).sort((a, b) => Date.parse(a.at) - Date.parse(b.at))) {
    if (record.type === 'health_day') continue;
    if (record.type === 'start') {
      if (sessions.has(record.id)) throw new Error('session log repeats a start; nothing was written');
      sessions.set(record.id, {
        id: record.id,
        kind: record.kind,
        planned_min: record.planned_min,
        started_at: record.at,
        planned_end_at: new Date(Date.parse(record.at) + record.planned_min * 60000).toISOString(),
        ended_at: null,
        status: 'running',
      });
      if (record.intention) sessions.get(record.id).intention = record.intention;
      events.set(record.id, []);
    } else {
      const session = sessions.get(record.id);
      if (!session) throw new Error(`session log has an ${record.type} without a start; nothing was written`);
      if (record.type !== 'end') {
        events.get(record.id).push(record);
        continue;
      }
      // How the block went counts from any end record: the newest answer wins, and
      // null (asked, skipped) only stands when there is no answer at all.
      if (record.outcome !== undefined && (record.outcome !== null || !outcomes.has(record.id))) {
        outcomes.set(record.id, record.outcome);
      }
      const previous = ends.get(record.id);
      // A person's end wins over an automatic observation, in either log order.
      if (!previous || (previous.inferred === true && record.inferred !== true)
        || ((previous.inferred === true) === (record.inferred === true)
          && Date.parse(record.at) < Date.parse(previous.at))) {
        ends.set(record.id, record);
      }
    }
  }
  for (const session of sessions.values()) {
    const end = ends.get(session.id);
    const timeline = events.get(session.id).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    for (const event of timeline) {
      const at = Date.parse(event.at);
      if (end && at > Date.parse(end.at)) break;
      if (session.status === 'running') {
        // A late pause cannot interrupt an already completed active stretch.
        if (at >= Date.parse(session.planned_end_at)) break;
        if (event.type !== 'pause') continue;
        session.status = 'paused';
        session.paused_at = event.at;
        session.paused_ms = session.paused_ms || 0;
      } else if (event.type === 'resume') {
        const duration = at - Date.parse(session.paused_at);
        if (duration > PAUSE_LIMIT_MS) {
          session.pause_expired_at = session.paused_at;
          break;
        }
        session.paused_ms += duration;
        session.planned_end_at = new Date(Date.parse(session.planned_end_at) + duration).toISOString();
        session.paused_at = null;
        session.status = 'running';
      }
    }
    if (end) {
      session.ended_at = end.at;
      session.status = end.status;
      if (end.note !== undefined) session.note = end.note;
      if (end.inferred === true) session.inferred = true;
      if (outcomes.has(session.id)) session.outcome = outcomes.get(session.id);
    }
  }
  return [...sessions.values()];
}

function runningSession(sessions, now) {
  const running = sessions.filter((session) => ['running', 'paused'].includes(session.status)
    && !automaticEndRecord(session, now));
  if (running.length > 1) throw new Error('session log has more than one running session; nothing was written');
  return running[0] || null;
}

function startRecord(kind, plannedMin, now, id, intention = '') {
  if (!validLength(kind, plannedMin)) throw new Error('choose a supported session length');
  const record = { v: 1, type: 'start', id, kind, planned_min: plannedMin, at: now.toISOString(), source: 'cli' };
  const line = kind === 'focus' ? oneLine(intention, INTENTION_MAX) : '';
  if (line) record.intention = line;
  return record;
}

// How a finished focus block went: yes, partly, no, or null for asked and skipped.
// Only a focus block that ran its full time carries it.
function withOutcome(record, session, outcome) {
  if ((outcome === null || OUTCOMES.includes(outcome)) && session.kind === 'focus' && record.status === 'done') {
    record.outcome = outcome;
  }
  return record;
}

// One more end line that adds the answer to a block that already ended. It sits after
// the real end, so every face keeps the earliest end and its time; only the answer is new.
function answerRecord(session, now, outcome) {
  const at = Math.max(now.getTime(), Date.parse(session.ended_at) + 1);
  return {
    v: 1, type: 'end', id: session.id, status: 'done', at: new Date(at).toISOString(), source: 'cli', inferred: true, outcome,
  };
}

// The server takes saves for the local today, and for yesterday until 3 in the morning.
function openDays(now) {
  const days = [localDate(now)];
  if (now.getHours() < 3) {
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    days.push(localDate(yesterday));
  }
  return days;
}

// Finished focus blocks made on this computer, still open for a save, never asked about.
function unansweredBlocks(records, now) {
  const sources = new Map(records.filter((record) => record.type === 'start').map((record) => [record.id, record.source]));
  const open = new Set(openDays(now));
  return foldSessions(records).filter((session) => session.kind === 'focus' && session.status === 'done'
    && session.outcome === undefined && ['cli', 'mac'].includes(sources.get(session.id))
    && open.has(localDate(new Date(session.started_at))));
}

function endRecord(session, now, note = '') {
  const done = session.status !== 'paused' && now.getTime() >= Date.parse(session.planned_end_at);
  const record = {
    v: 1,
    type: 'end',
    id: session.id,
    status: done ? 'done' : 'partial',
    at: done ? session.planned_end_at : now.toISOString(),
    source: 'cli',
  };
  const oneLine = String(note).replace(/\s+/g, ' ').trim();
  if (oneLine) record.note = oneLine;
  return record;
}

function automaticEndRecord(session, now) {
  if (!['running', 'paused'].includes(session.status)) return null;
  const expired = session.pause_expired_at || (session.status === 'paused'
    && now.getTime() - Date.parse(session.paused_at) > PAUSE_LIMIT_MS ? session.paused_at : null);
  if (expired) {
    return { v: 1, type: 'end', id: session.id, status: 'partial', at: expired, source: 'cli', inferred: true };
  }
  if (session.status === 'running' && now.getTime() >= Date.parse(session.planned_end_at)) {
    return { ...endRecord(session, now), inferred: true };
  }
  return null;
}

function pauseRecord(session, now) {
  if (!session || automaticEndRecord(session, now)) throw new Error('nothing running');
  if (session.status === 'paused') throw new Error('session is already paused; use atris 99 resume');
  if (session.status !== 'running') throw new Error('nothing running');
  return { v: 1, type: 'pause', id: session.id, at: now.toISOString(), source: 'cli' };
}

function resumeRecord(session, now) {
  if (!session || automaticEndRecord(session, now)) throw new Error('nothing paused');
  if (session.status !== 'paused') throw new Error('session is not paused');
  return { v: 1, type: 'resume', id: session.id, at: now.toISOString(), source: 'cli' };
}

function activeMilliseconds(session, now) {
  const end = session.ended_at ? Date.parse(session.ended_at) : now.getTime();
  const until = session.paused_at ? Math.min(end, Date.parse(session.paused_at)) : end;
  return Math.max(0, until - Date.parse(session.started_at) - (session.paused_ms || 0));
}

function sessionStatus(session, now) {
  return {
    running: session ? {
      ...session,
      remaining_seconds: Math.max(0, Math.ceil((session.planned_min * 60000 - activeMilliseconds(session, now)) / 1000)),
    } : null,
  };
}

function localDate(date) {
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
}

function sessionsToday(sessions, now) {
  const date = localDate(now);
  const done = sessions.filter((session) => session.status === 'done'
    && localDate(new Date(session.ended_at)) === date);
  return {
    date,
    sessions: sessions.filter((session) => localDate(new Date(session.started_at)) === date
      || (session.ended_at && localDate(new Date(session.ended_at)) === date)),
    finished_minutes: done.reduce((minutes, session) => minutes + session.planned_min, 0),
    counts: {
      focus: done.filter((session) => session.kind === 'focus').length,
      meditate: done.filter((session) => session.kind === 'meditate').length,
    },
  };
}

// A focus block counts on the local day it started, as on the phone.
function blocksToday(sessions, now) {
  const date = localDate(now);
  const blocks = sessions.filter((session) => session.kind === 'focus' && session.status === 'done'
    && localDate(new Date(session.started_at)) === date);
  return { count: blocks.length, minutes: blocks.reduce((sum, session) => sum + session.planned_min, 0) };
}

// 125 is "2 hours 5 minutes", 60 is "1 hour", 25 is "25 minutes".
function blockDuration(minutes) {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const hourText = hours === 1 ? '1 hour' : `${hours} hours`;
  const minuteText = rest === 1 ? '1 minute' : `${rest} minutes`;
  if (hours === 0) return minuteText;
  return rest === 0 ? hourText : `${hourText} ${minuteText}`;
}

// "3 blocks, 2 hours 5 minutes"; null with no finished block.
function blocksLine({ count, minutes }) {
  if (!count) return null;
  return `${count === 1 ? '1 block' : `${count} blocks`}, ${blockDuration(minutes)}`;
}

function offsetMinutesAt(date) {
  return -date.getTimezoneOffset();
}

// ISO 8601 with the local offset at that moment, whole seconds, like the phone writes.
function isoWithOffset(date) {
  const offset = offsetMinutesAt(date);
  const local = new Date(date.getTime() + offset * 60000).toISOString().slice(0, 19);
  if (offset === 0) return `${local}Z`;
  const sign = offset < 0 ? '-' : '+';
  const abs = Math.abs(offset);
  return `${local}${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

// A finished focus block in the shape of "Contract: blocks" in project99's deep-work idea.
// Only blocks made on this computer go; the phone sends its own.
function blockFromSession(session) {
  if (session.kind !== 'focus' || session.status !== 'done' || !UUID.test(session.id)) return null;
  const started = new Date(session.started_at);
  return {
    day: localDate(started),
    tz_offset_minutes: offsetMinutesAt(started),
    block: {
      id: session.id,
      minutes: session.planned_min,
      intention: oneLine(session.intention, INTENTION_MAX),
      started_at: isoWithOffset(started),
      ended_at: isoWithOffset(new Date(session.ended_at)),
      outcome: session.outcome ?? null,
      note: oneLine(session.note, BLOCK_NOTE_MAX),
    },
  };
}

function localBlocks(records) {
  const sources = new Map(records.filter((record) => record.type === 'start').map((record) => [record.id, record.source]));
  return foldSessions(records)
    .filter((session) => ['cli', 'mac'].includes(sources.get(session.id)))
    .map(blockFromSession)
    .filter(Boolean);
}

function healthToday(records, now) {
  const date = localDate(now);
  let latest;
  for (const record of records) {
    if (record.type === 'health_day' && record.date === date
      && (!latest || Date.parse(record.at) >= Date.parse(latest.at))) latest = record;
  }
  return latest;
}

function healthSummary(record) {
  const parts = [];
  if (record.sleep_min !== undefined) parts.push(`sleep ${Math.floor(record.sleep_min / 60)}h ${record.sleep_min % 60}m`);
  if (record.steps !== undefined) parts.push(`${record.steps.toLocaleString('en-US')} steps`);
  if (record.workout_min !== undefined) parts.push(`workout ${record.workout_min} min`);
  if (record.mindful_min !== undefined) parts.push(`mindful ${record.mindful_min} min`);
  return `Health: ${parts.join(', ') || 'unknown'}`;
}

module.exports = {
  OUTCOMES,
  INTENTION_MAX,
  BLOCK_NOTE_MAX,
  oneLine,
  localDate,
  withOutcome,
  answerRecord,
  openDays,
  unansweredBlocks,
  blocksToday,
  blockDuration,
  blocksLine,
  isoWithOffset,
  blockFromSession,
  localBlocks,
  validLength,
  parseSessionLog,
  foldSessions,
  runningSession,
  startRecord,
  endRecord,
  automaticEndRecord,
  pauseRecord,
  resumeRecord,
  activeMilliseconds,
  sessionStatus,
  sessionsToday,
  healthToday,
  healthSummary,
  lineIdentity,
  uniqueLines,
};
