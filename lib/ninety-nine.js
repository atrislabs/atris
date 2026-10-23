'use strict';

const LENGTHS = { focus: [25, 50, 90], meditate: [10, 20, 30] };
const SOURCES = ['cli', 'mac', 'ios'];

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
      && (record.note === undefined || (typeof record.note === 'string' && !/[\r\n\u2028\u2029]/.test(record.note)));
    if (!common || (!start && !end)) {
      throw new Error(`session log has an invalid record on line ${index + 1}; nothing was written`);
    }
    return [record];
  });
}

// records -> sessions -> overdue ends -> the requested action
function foldSessions(records) {
  const sessions = new Map();
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
    } else {
      const session = sessions.get(record.id);
      if (!session) throw new Error('session log has an end without a start; nothing was written');
      // Two faces may notice the same overdue session. Count it only once.
      if (session.ended_at) continue;
      session.ended_at = record.at;
      session.status = record.status;
      if (record.note !== undefined) session.note = record.note;
    }
  }
  return [...sessions.values()];
}

function runningSession(sessions, now) {
  const running = sessions.filter((session) => session.status === 'running'
    && Date.parse(session.planned_end_at) > now.getTime());
  if (running.length > 1) throw new Error('session log has more than one running session; nothing was written');
  return running[0] || null;
}

function startRecord(kind, plannedMin, now, id) {
  if (!validLength(kind, plannedMin)) throw new Error('choose a supported session length');
  return { v: 1, type: 'start', id, kind, planned_min: plannedMin, at: now.toISOString(), source: 'cli' };
}

function endRecord(session, now, note = '') {
  const done = now.getTime() >= Date.parse(session.planned_end_at);
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

function sessionStatus(session, now) {
  return {
    running: session ? {
      ...session,
      remaining_seconds: Math.max(0, Math.ceil((Date.parse(session.planned_end_at) - now.getTime()) / 1000)),
    } : null,
  };
}

function localDate(date) {
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
}

function sessionsToday(sessions, now) {
  const date = localDate(now);
  return {
    date,
    sessions: sessions.filter((session) => localDate(new Date(session.started_at)) === date
      || (session.ended_at && localDate(new Date(session.ended_at)) === date)),
    finished_minutes: sessions.reduce((minutes, session) => minutes + (
      session.status === 'done' && localDate(new Date(session.ended_at)) === date ? session.planned_min : 0
    ), 0),
  };
}

module.exports = {
  validLength,
  parseSessionLog,
  foldSessions,
  runningSession,
  startRecord,
  endRecord,
  sessionStatus,
  sessionsToday,
};
