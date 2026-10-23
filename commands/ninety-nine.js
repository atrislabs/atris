'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { argsWantHelp } = require('../lib/noninteractive');
const { getAtrisDir } = require('../utils/auth');
const {
  validLength,
  parseSessionLog,
  foldSessions,
  runningSession,
  startRecord,
  endRecord,
  automaticEndRecord,
  pauseRecord,
  resumeRecord,
  sessionStatus,
  sessionsToday,
} = require('../lib/ninety-nine');

function usage() {
  return [
    'usage: atris 99 focus <25|50|90>',
    '       atris 99 meditate <10|20|30>',
    '       atris 99 stop [note words]',
    '       atris 99 pause',
    '       atris 99 resume',
    '       atris 99 status [--json]',
    '       atris 99 today [--json]',
  ].join('\n');
}

function readLog(logPath) {
  try { return fs.readFileSync(logPath, 'utf8'); } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  }
}

function appendRecord(logPath, previousText, record) {
  // A valid last record may lack a newline. Preserve every existing byte.
  const separator = previousText && !previousText.endsWith('\n') ? '\n' : '';
  const line = `${separator}${JSON.stringify(record)}\n`;
  fs.appendFileSync(logPath, line, { mode: 0o600 });
  return previousText + line;
}

function ninetyNineAtris(args = process.argv.slice(3), {
  log = console.log,
  now = () => new Date(),
  logPath,
} = {}) {
  const [action, ...rest] = args;
  // Words after stop belong to its note, including the word "help".
  if ((action !== 'stop' && argsWantHelp(args)) || (action === 'stop' && ['--help', '-h'].includes(rest[0]))) {
    log(usage());
    return 0;
  }
  const json = rest.includes('--json');
  if (action === 'focus' || action === 'meditate') {
    if (rest.length !== 1 || !validLength(action, Number(rest[0])) || String(Number(rest[0])) !== rest[0]) {
      log(action === 'focus' ? 'choose focus 25, 50, or 90 minutes' : 'choose meditate 10, 20, or 30 minutes');
      return 2;
    }
  } else if (action === 'status' || action === 'today') {
    if (rest.length > 1 || (rest.length === 1 && !json)) {
      log(`usage: atris 99 ${action} [--json]`);
      return 2;
    }
  } else if (action === 'pause' || action === 'resume') {
    if (rest.length) {
      log(`usage: atris 99 ${action}`);
      return 2;
    }
  } else if (action !== 'stop') {
    log(usage());
    return 2;
  }

  let lock;
  let lockPath;
  try {
    const override = logPath || process.env.ATRIS_99_LOG;
    const file = override || path.join(getAtrisDir(), '99', 'sessions.jsonl');
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // An override may live in a shared folder. Only tighten our own folder.
    if (!override) fs.chmodSync(dir, 0o700);
    lockPath = `${file}.lock`;
    try { lock = fs.openSync(lockPath, 'wx', 0o600); } catch (error) {
      if (error.code === 'EEXIST') throw new Error('session log is busy; try again');
      throw error;
    }
    let text = readLog(file);
    const records = parseSessionLog(text);
    let sessions = foldSessions(records);
    const time = now();
    let active = runningSession(sessions, time);
    const stopTarget = action === 'stop'
      ? active || sessions.findLast((session) => automaticEndRecord(session, time)?.status === 'done')
      : null;

    for (const session of sessions) {
      const end = automaticEndRecord(session, time);
      if (end && session !== stopTarget) {
        text = appendRecord(file, text, end);
        records.push(end);
      }
    }

    if (action === 'stop') {
      if (!stopTarget) {
        log('nothing running');
        return 1;
      }
      const end = endRecord(stopTarget, time, rest.join(' '));
      appendRecord(file, text, end);
      log(`${stopTarget.kind} ${end.status}: ${end.status === 'done' ? stopTarget.planned_min : 0} finished minutes`);
      return 0;
    }

    sessions = foldSessions(records);
    active = runningSession(sessions, time);
    if (action === 'focus' || action === 'meditate') {
      if (active) {
        log('a session is already running; use atris 99 stop first');
        return 1;
      }
      appendRecord(file, text, startRecord(action, Number(rest[0]), time, randomUUID()));
      log(`${action} started for ${rest[0]} minutes`);
    } else if (action === 'pause' || action === 'resume') {
      let record;
      try {
        record = action === 'pause' ? pauseRecord(active, time) : resumeRecord(active, time);
      } catch (error) {
        log(error.message);
        return 1;
      }
      appendRecord(file, text, record);
      log(`${active.kind} ${action === 'pause' ? 'paused' : 'resumed'}`);
    } else if (action === 'status') {
      const result = sessionStatus(active, time);
      if (json) log(JSON.stringify(result));
      else if (!active) log('nothing running');
      else {
        const seconds = result.running.remaining_seconds;
        log(`${active.kind}: ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} left${active.status === 'paused' ? ' (paused)' : ''}`);
      }
    } else {
      const result = sessionsToday(sessions, time);
      if (json) log(JSON.stringify(result));
      else {
        for (const session of result.sessions) {
          log(`${session.kind} ${session.planned_min} minutes: ${session.status}`);
        }
        log(`${result.finished_minutes} finished minutes today`);
        log(`Today: ${result.counts.focus} focus, ${result.counts.meditate} meditate, ${result.finished_minutes} min`);
      }
    }
    return 0;
  } catch (error) {
    const message = error.code ? 'check the file path and its permissions' : error.message;
    log(`could not use the session log: ${String(message).replace(/\s+/g, ' ')}`);
    return 1;
  } finally {
    if (lock !== undefined) {
      fs.closeSync(lock);
      fs.unlinkSync(lockPath);
    }
  }
}

module.exports = { ninetyNineAtris };
