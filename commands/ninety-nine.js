'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { argsWantHelp } = require('../lib/noninteractive');
const { getAtrisDir, loadCredentials } = require('../utils/auth');
const { stateHome } = require('../lib/state-home');
const { validateSync, checkpointKey, syncLines } = require('../lib/ninety-nine-sync');
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
  healthToday,
  healthSummary,
} = require('../lib/ninety-nine');

function usage() {
  return [
    'usage: atris 99 focus <25|50|90>',
    '       atris 99 meditate <10|20|30>',
    '       atris 99                         show the timer and today',
    '       atris 99 <25|50|90>              start focus',
    '       atris 99 <10|20|30>              start meditation',
    '       atris 99 f <25|50|90>',
    '       atris 99 m <10|20|30>',
    '       atris 99 start <focus|meditate> <minutes>',
    '       atris 99 again                   repeat the last finished session',
    '       atris 99 stop [note words]',
    '       atris 99 pause',
    '       atris 99 resume',
    '       atris 99 status [--json]',
    '       atris 99 today [--json]',
    '       atris 99 sync [--dry-run]',
    '       atris 99 help | --help',
    '',
    'sync is off without a sync block in ~/.atris/99/config.json (ATRIS_99_CONFIG overrides it).',
    'personal: {"sync":{"target":"personal","app_slug":"project-99"}}',
    'workspace: {"sync":{"target":"workspace","business":"your-business","workspace":"optional-id"}}',
    'both targets merge in both directions; workspace reads atris/99/sessions.*.jsonl and legacy sessions.jsonl.',
    'workspace writes only sessions.<device>.jsonl; its stable device id lives in the local sync state.',
    'personal uses your user login and defaults to app_slug project-99; its records api must be deployed first.',
    'dry-run reads cloud records and shows missing lines without saving logs or the sync cursor.',
  ].join('\n');
}

function readJson(file, fallback) {
  const text = readLog(file);
  if (!text) return fallback;
  try { return JSON.parse(text); } catch { throw new Error('check the 99 config or sync-state json'); }
}

function saveSyncState(file, state) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

async function syncNinetyNine(args, { log, logPath, configPath, statePath, request, credentials = loadCredentials }) {
  if (args.length > 1 || (args.length === 1 && args[0] !== '--dry-run')) {
    log('usage: atris 99 sync [--dry-run]');
    return 2;
  }
  let lock;
  let lockPath;
  let stateLock;
  let stateLockPath;
  try {
    const dir = path.join(stateHome(), '.atris', '99');
    const config = readJson(configPath || process.env.ATRIS_99_CONFIG || path.join(dir, 'config.json'), {});
    if (!config?.sync) {
      log('sync is off (local only)');
      return 0;
    }
    validateSync(config.sync);
    const creds = await credentials();
    if (!creds?.token) throw new Error('sync needs your signed-in user login; run atris login');
    const dryRun = args.includes('--dry-run');
    const file = logPath || process.env.ATRIS_99_LOG || path.join(dir, 'sessions.jsonl');
    const stateFile = statePath || path.join(dir, 'sync-state.json');
    if (!dryRun) {
      for (const folder of new Set([path.dirname(file), path.dirname(stateFile)])) {
        fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
      }
      // Serialize cursor updates, even if callers use different local logs.
      stateLockPath = `${stateFile}.lock`;
      stateLock = fs.openSync(stateLockPath, 'wx', 0o600);
      lockPath = `${file}.lock`;
      lock = fs.openSync(lockPath, 'wx', 0o600);
    }
    let text = readLog(file);
    const records = parseSessionLog(text);
    const state = readJson(stateFile, { v: 1, targets: {} });
    if (state?.v !== 1 || !state.targets || typeof state.targets !== 'object' || Array.isArray(state.targets)) {
      throw new Error('check the 99 sync-state json');
    }
    const key = checkpointKey(config.sync, creds);
    const checkpoint = state.targets[key] || {};
    if ((checkpoint.known !== undefined && (!Array.isArray(checkpoint.known) || !checkpoint.known.every((item) => typeof item === 'string')))
      || (checkpoint.since != null && !Number.isFinite(Date.parse(checkpoint.since)))) {
      throw new Error('check the 99 sync-state json');
    }
    if (config.sync.target === 'workspace' && state.device_id === undefined) {
      state.device_id = randomUUID();
      // Save the identity before uploading, even if the reply or later log save fails.
      // The state lock keeps simultaneous local runs on the same device file.
      if (!dryRun) saveSyncState(stateFile, state);
    }
    const result = await syncLines({ records, sync: config.sync, checkpoint, deviceId: state.device_id, credentials: creds, dryRun, request });
    if (dryRun) {
      log(`would send ${result.send.length} lines and pull ${result.pull.length} lines (${config.sync.target})`);
      for (const record of result.send) log(`send: ${JSON.stringify(record)}`);
      for (const record of result.pull) log(`pull: ${JSON.stringify(record)}`);
    } else {
      for (const record of result.pull) text = appendRecord(file, text, record);
      state.targets[key] = result.checkpoint;
      saveSyncState(stateFile, state);
      log(`sent ${result.send.length} lines and pulled ${result.pull.length} lines (${config.sync.target})`);
    }
    return 0;
  } catch (error) {
    const message = error.code === 'EEXIST' ? 'session sync is busy; try again'
      : error.code ? 'check the sync file paths and permissions' : error.message;
    log(`could not sync: ${String(message).replace(/\s+/g, ' ')}`);
    return 1;
  } finally {
    for (const [handle, file] of [[lock, lockPath], [stateLock, stateLockPath]]) {
      if (handle !== undefined) {
        fs.closeSync(handle);
        fs.unlinkSync(file);
      }
    }
  }
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

function todayLine(result) {
  return `Today: ${result.counts.focus} focus, ${result.counts.meditate} meditate, ${result.finished_minutes} min`;
}

function kindName(kind) {
  return kind === 'focus' ? 'Focus' : 'Meditate';
}

function ninetyNineAtris(args = process.argv.slice(3), {
  log = console.log,
  now = () => new Date(),
  logPath,
  configPath,
  statePath,
  request,
  credentials,
} = {}) {
  let [action, ...rest] = args;
  const overview = args.length === 0;
  // Words after stop belong to its note, including the word "help".
  if ((action !== 'stop' && argsWantHelp(args)) || (action === 'stop' && ['--help', '-h'].includes(rest[0]))) {
    log(usage());
    return 0;
  }
  if (action === 'sync') return syncNinetyNine(rest, { log, logPath, configPath, statePath, request, credentials });
  if (action === 'start' && ['focus', 'meditate', 'f', 'm'].includes(rest[0])) [action, ...rest] = rest;
  if (action === 'f') action = 'focus';
  if (action === 'm') action = 'meditate';
  for (const kind of ['focus', 'meditate']) {
    if (validLength(kind, Number(action)) && String(Number(action)) === action) {
      rest.unshift(action);
      action = kind;
      break;
    }
  }
  const json = rest.includes('--json');
  if (action === 'focus' || action === 'meditate') {
    const lengths = action === 'focus' ? '25 | 50 | 90' : '10 | 20 | 30';
    if (rest.length === 0) {
      log(`Pick a length: atris 99 ${action} ${lengths}`);
      return 1;
    }
    if (rest.length !== 1 || !validLength(action, Number(rest[0])) || String(Number(rest[0])) !== rest[0]) {
      log(`Allowed ${action} lengths: ${lengths.replaceAll(' | ', ', ')} minutes.`);
      return 1;
    }
  } else if (action === 'status' || action === 'today') {
    if (rest.length > 1 || (rest.length === 1 && !json)) {
      log(`usage: atris 99 ${action} [--json]`);
      return 2;
    }
  } else if (action === 'pause' || action === 'resume' || action === 'again') {
    if (rest.length) {
      log(`usage: atris 99 ${action}`);
      return 2;
    }
  } else if (action !== 'stop' && !overview) {
    log(`Unknown: ${action}. Try: atris 99 help`);
    return 1;
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
      records.push(end);
      log(`${stopTarget.kind} ${end.status}: ${end.status === 'done' ? stopTarget.planned_min : 0} finished minutes`);
      log(todayLine(sessionsToday(foldSessions(records), time)));
      return 0;
    }

    sessions = foldSessions(records);
    active = runningSession(sessions, time);
    if (action === 'again') {
      const previous = sessions.filter((session) => session.status === 'done')
        .sort((a, b) => Date.parse(b.ended_at) - Date.parse(a.ended_at))[0];
      if (!previous) {
        log('No finished session yet. Try: atris 99 50');
        return 1;
      }
      action = previous.kind;
      rest = [String(previous.planned_min)];
    }
    if (overview) {
      if (!active) log('Nothing running.');
      else if (active.status === 'paused') log(`${kindName(active.kind)} · paused`);
      else {
        const seconds = sessionStatus(active, time).running.remaining_seconds;
        log(`${kindName(active.kind)} · ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} left`);
      }
      log(todayLine(sessionsToday(sessions, time)));
      log('Start: atris 99 50   Again: atris 99 again   Help: atris 99 help');
    } else if (action === 'focus' || action === 'meditate') {
      if (active) {
        log('a session is already running; use atris 99 stop first');
        return 1;
      }
      appendRecord(file, text, startRecord(action, Number(rest[0]), time, randomUUID()));
      const end = new Date(time.getTime() + Number(rest[0]) * 60000);
      const endsAt = end.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
      log(`${kindName(action)} ${rest[0]} started. Ends at ${endsAt}.`);
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
      const health = healthToday(records, time);
      if (health) result.health_day = health;
      if (json) log(JSON.stringify(result));
      else {
        for (const session of result.sessions) {
          log(`${session.kind} ${session.planned_min} minutes: ${session.status}`);
        }
        log(`${result.finished_minutes} finished minutes today`);
        log(todayLine(result));
        if (health) log(healthSummary(health));
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
