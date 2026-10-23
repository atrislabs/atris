'use strict';

const LENGTHS = { focus: [25, 50, 90], meditate: [10, 20, 30] };
const SOURCES = ['cli', 'mac', 'ios'];
const PAUSE_LIMIT_MS = 30 * 60000;

function validLength(kind, minutes) {
  return Object.hasOwn(LENGTHS, kind) && LENGTHS[kind].includes(minutes);
}

function parseSessionLog(text) {
  return text.split('\n').flatMap((line, index) => {
    if (!line.trim()) return [];
    let record;
    try { record = JSON.parse(line); } catch { /* Report the line below. */ }
    const common = record && record.v === 1 && typeof record.id === 'string'
      && record.id && SOURCES.includes(record.source)
      && typeof record.at === 'string' && Number.isFinite(Date.parse(record.at));
    const start = record?.type === 'start' && validLength(record.kind, record.planned_min);
    const end = record?.type === 'end' && ['done', 'partial'].includes(record.status)
      && (record.inferred === undefined || typeof record.inferred === 'boolean')
      && (record.note === undefined || (typeof record.note === 'string' && !/[\r\n\u2028\u2029]/.test(record.note)));
    const pause = ['pause', 'resume'].includes(record?.type);
    if (!common || (!start && !end && !pause)) {
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
  for (const record of records) {
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
      events.set(record.id, []);
    } else {
      const session = sessions.get(record.id);
      if (!session) throw new Error(`session log has an ${record.type} without a start; nothing was written`);
      if (record.type !== 'end') {
        events.get(record.id).push(record);
        continue;
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

function startRecord(kind, plannedMin, now, id) {
  if (!validLength(kind, plannedMin)) throw new Error('choose a supported session length');
  return { v: 1, type: 'start', id, kind, planned_min: plannedMin, at: now.toISOString(), source: 'cli' };
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

module.exports = {
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
};
