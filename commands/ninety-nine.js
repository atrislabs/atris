'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { argsWantHelp } = require('../lib/noninteractive');
const { getAtrisDir, loadCredentials } = require('../utils/auth');
const { stateHome } = require('../lib/state-home');
const tty = require('node:tty');
const { apiRequestJson } = require('../utils/api');
const { validateSync, checkpointKey, syncLines, syncBlocks, blockAccountKey } = require('../lib/ninety-nine-sync');
const {
  OUTCOMES,
  INTENTION_MAX,
  BLOCK_NOTE_MAX,
  oneLine,
  localDate,
  withOutcome,
  answerRecord,
  unansweredBlocks,
  blocksToday,
  blocksLine,
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
} = require('../lib/ninety-nine');

function usage() {
  return [
    'usage: atris 99 focus <25|50|90> ["what you will get done"]',
    '       atris 99 meditate <10|20|30>',
    '       atris 99                         show the timer and today',
    '       atris 99 <25|50|90> [intention]  start focus',
    '       atris 99 <10|20|30>              start meditation',
    '       atris 99 f <25|50|90>',
    '       atris 99 m <10|20|30>',
    '       atris 99 start <focus|meditate> <minutes>',
    '       atris 99 again                   repeat the last finished session',
    '       atris 99 stop [--outcome yes|partly|no] [--note text] [note words]',
    '       atris 99 pause',
    '       atris 99 resume',
    '       atris 99 status [--json]',
    '       atris 99 today [--json]',
    '       atris 99 sync [--dry-run]',
    '       atris 99 help | --help',
    '',
    'a focus block that runs its full time asks "Did you get it done? (yes/partly/no)" in a terminal;',
    '--outcome and --note answer it without asking. Scripts are never asked.',
    'with sync on, each finished focus block also goes to your Project 99 day, so every face shows one count.',
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

async function syncNinetyNine(args, { log, logPath, configPath, statePath, request, credentials = loadCredentials, now = () => new Date() }) {
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
    if (state.blocks !== undefined && (!state.blocks || typeof state.blocks !== 'object' || Array.isArray(state.blocks))) {
      throw new Error('check the 99 sync-state json');
    }
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
    return await sendBlocks({ records: [...records, ...result.pull], state, stateFile, creds, dryRun, request, now, log });
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

async function sendBlocks({ records, state, stateFile, creds, dryRun, request, now, log }) {
  const key = blockAccountKey(creds);
  const sent = state.blocks?.[key];
  let result;
  try {
    result = await syncBlocks({
      records, credentials: creds, dryRun, request, now: now(),
      sent: sent && typeof sent === 'object' && !Array.isArray(sent) ? sent : {},
    });
  } catch (error) {
    log(`could not send focus blocks: ${String(error.message).replace(/\s+/g, ' ')}`);
    return 1;
  }
  const count = result.send.length;
  const blocks = `${count} focus block${count === 1 ? '' : 's'}`;
  if (dryRun) {
    if (count) log(`would send ${blocks}`);
    for (const block of result.send) log(`block: ${JSON.stringify(block)}`);
    return 0;
  }
  if (result.locked) {
    log('focus blocks stay on this computer: deep work needs Project 99 Plus');
    return 0;
  }
  state.blocks = { ...(state.blocks || {}), [key]: result.sent };
  saveSyncState(stateFile, state);
  if (result.refused) log(`the 99 server refused some focus blocks (${result.refused}); they will not be sent again`);
  else if (count) log(`sent ${blocks}`);
  if (result.line) log(`Deep work today: ${result.line}`);
  return 0;
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

function parseOutcome(text) {
  const answer = String(text ?? '').trim().toLowerCase();
  if (['y', 'yes'].includes(answer)) return 'yes';
  if (['p', 'partly', 'partial'].includes(answer)) return 'partly';
  if (['n', 'no'].includes(answer)) return 'no';
  return answer ? undefined : null;
}

// One line from the terminal, read without a stream so the command stays synchronous.
function askTerminal(question) {
  process.stdout.write(question);
  const bytes = [];
  const one = Buffer.alloc(1);
  for (;;) {
    let read;
    try { read = fs.readSync(0, one, 0, 1, null); } catch (error) {
      if (error.code === 'EAGAIN') {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50); // stdin not ready yet
        continue;
      }
      return '';
    }
    if (read === 0 || one[0] === 10) break;
    bytes.push(one[0]);
  }
  return Buffer.from(bytes).toString('utf8');
}

// "Did you get it done?" until a clear answer, at most twice. Empty skips it: null.
function askOutcome(ask, lead) {
  for (let tries = 0; tries < 2; tries++) {
    const answer = parseOutcome(ask(`${lead}Did you get it done? (yes/partly/no) `));
    if (answer !== undefined) return answer;
  }
  return null;
}

// The sessions as the command finds them: who is running, what stop would end, and
// the ends to write for timers that finished or pauses that ran out.
function observe(records, time, action) {
  const sessions = foldSessions(records);
  const active = runningSession(sessions, time);
  const stopTarget = action === 'stop'
    ? active || sessions.findLast((session) => automaticEndRecord(session, time)?.status === 'done')
    : null;
  const ends = sessions.filter((session) => session !== stopTarget)
    .map((session) => automaticEndRecord(session, time)).filter(Boolean);
  return { sessions, active, stopTarget, ends };
}

function lead(session) {
  return `Focus ${session.planned_min} ended${session.intention ? ` (${session.intention})` : ''}. `;
}

// The questions this command would ask, asked now: block id -> yes, partly, no or null.
// A log that cannot be read asks nothing; the locked read reports it.
function askFirst(text, time, action, stopping, ask) {
  const answers = new Map();
  let records;
  let seen;
  try {
    records = parseSessionLog(text);
    seen = observe(records, time, action);
  } catch {
    return answers;
  }
  records.push(...seen.ends);
  const unanswered = unansweredBlocks(records, time);
  if (action === 'stop') {
    if (stopping.outcome !== undefined) return answers;
    const target = seen.stopTarget;
    if (target) {
      if (target.kind === 'focus' && endRecord(target, time).status === 'done') answers.set(target.id, askOutcome(ask, ''));
    } else if (unanswered.length) {
      const last = unanswered.at(-1);
      answers.set(last.id, askOutcome(ask, lead(last)));
    }
    return answers;
  }
  for (const session of unanswered) answers.set(session.id, askOutcome(ask, lead(session)));
  return answers;
}

async function fetchSuggestion(time, { request = apiRequestJson, credentials = loadCredentials } = {}) {
  try {
    const creds = credentials();
    if (!creds?.token) return '';
    const query = new URLSearchParams({ day: localDate(time), tz_offset_minutes: String(-time.getTimezoneOffset()) });
    const response = await request(`/99/focus/suggestion?${query}`, {
      method: 'GET', token: creds.token, timeoutMs: 6000, retries: 0,
    });
    const line = response?.ok && typeof response.data?.suggestion === 'string' ? response.data.suggestion : '';
    return oneLine(line, 120);
  } catch {
    return '';
  }
}

function stopArgs(words) {
  const out = { note: [], outcome: undefined, flagNote: undefined };
  for (let index = 0; index < words.length; index++) {
    const word = words[index];
    const [flag, inline] = word.startsWith('--') ? [word.split('=')[0], word.includes('=') ? word.slice(word.indexOf('=') + 1) : undefined] : [];
    if (flag === '--outcome' || flag === '--note') {
      const value = inline !== undefined ? inline : words[++index];
      if (value === undefined) return { error: true };
      if (flag === '--outcome') {
        if (!OUTCOMES.includes(value)) return { error: true };
        out.outcome = value;
      } else out.flagNote = value;
    } else out.note.push(word);
  }
  const note = out.flagNote !== undefined ? [out.flagNote, ...out.note].join(' ') : out.note.join(' ');
  return { outcome: out.outcome, note: oneLine(note, BLOCK_NOTE_MAX) };
}

function kindName(kind) {
  return kind === 'focus' ? 'Focus' : 'Meditate';
}

function timeLeft(session, time) {
  const seconds = sessionStatus(session, time).running.remaining_seconds;
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function runningLine(active, time) {
  return `${kindName(active.kind)} · ${timeLeft(active, time)} left${active.status === 'paused' ? ' · paused' : ''}`
    + (active.intention ? ` · ${active.intention}` : '');
}

function localEndTime(end) {
  return end.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}

function ninetyNineAtris(args = process.argv.slice(3), {
  log = console.log,
  now = () => new Date(),
  logPath,
  configPath,
  statePath,
  request,
  credentials,
  interactive = tty.isatty(0),
  ask = askTerminal,
  suggestion = (time) => fetchSuggestion(time, { request, credentials }),
} = {}) {
  let [action, ...rest] = args;
  const overview = args.length === 0;
  // Words after stop belong to its note, including the word "help".
  if ((action !== 'stop' && argsWantHelp(args)) || (action === 'stop' && ['--help', '-h'].includes(rest[0]))) {
    log(usage());
    return 0;
  }
  if (action === 'sync') return syncNinetyNine(rest, { log, logPath, configPath, statePath, request, credentials, now });
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
  let intention = '';
  let stopping;
  if (action === 'focus' || action === 'meditate') {
    const lengths = action === 'focus' ? '25 | 50 | 90' : '10 | 20 | 30';
    if (rest.length === 0) {
      log(`Pick a length: atris 99 ${action} ${lengths}`);
      return 1;
    }
    // Focus takes what the block is for after its length; meditation takes nothing more.
    const words = rest.slice(1);
    if ((action === 'focus' ? words.some((word) => word.startsWith('--')) : words.length)
      || !validLength(action, Number(rest[0])) || String(Number(rest[0])) !== rest[0]) {
      log(`Allowed ${action} lengths: ${lengths.replaceAll(' | ', ', ')} minutes.`);
      return 1;
    }
    intention = oneLine(words.join(' '), INTENTION_MAX);
    rest = [rest[0]];
  } else if (action === 'stop') {
    stopping = stopArgs(rest);
    if (stopping.error) {
      log('usage: atris 99 stop [--outcome yes|partly|no] [--note text] [note words]');
      return 2;
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
    const time = now();
    const override = logPath || process.env.ATRIS_99_LOG;
    const file = override || path.join(getAtrisDir(), '99', 'sessions.jsonl');
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // An override may live in a shared folder. Only tighten our own folder.
    if (!override) fs.chmodSync(dir, 0o700);
    // Ask a person at a terminal before taking the lock, so an open question never
    // makes another command or the Mac app wait. Scripts and json readers are never asked.
    const answers = interactive && !json ? askFirst(readLog(file), time, action, stopping, ask) : new Map();
    lockPath = `${file}.lock`;
    try { lock = fs.openSync(lockPath, 'wx', 0o600); } catch (error) {
      if (error.code === 'EEXIST') throw new Error('session log is busy; try again');
      throw error;
    }
    let text = readLog(file);
    const records = parseSessionLog(text);
    const seen = observe(records, time, action);
    let sessions = seen.sessions;
    let active = seen.active;
    const stopTarget = seen.stopTarget;
    for (const end of seen.ends) {
      text = appendRecord(file, text, end);
      records.push(end);
    }

    const answer = (session, outcome) => {
      const record = answerRecord(session, time, outcome);
      text = appendRecord(file, text, record);
      records.push(record);
    };
    if (action !== 'stop') {
      for (const session of unansweredBlocks(records, time)) {
        if (answers.has(session.id)) answer(session, answers.get(session.id));
      }
    }

    if (action === 'stop') {
      if (!stopTarget) {
        // Nothing running: --outcome, or the question, answers the last block that ended on its own.
        const last = unansweredBlocks(records, time).at(-1);
        const outcome = last && (stopping.outcome ?? answers.get(last.id));
        if (last && outcome !== undefined) {
          answer(last, outcome);
          log(`Focus ${last.planned_min}: ${outcome || 'skipped'}.`);
          return 0;
        }
        log('Nothing running. Start one: atris 99 50');
        return 1;
      }
      const end = endRecord(stopTarget, time, stopping.note);
      withOutcome(end, stopTarget, stopping.outcome ?? answers.get(stopTarget.id));
      appendRecord(file, text, end);
      records.push(end);
      log(end.status === 'done'
        ? `${kindName(stopTarget.kind)} ${stopTarget.planned_min} done.`
        : "Stopped early, so it doesn't count.");
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
      else log(runningLine(active, time));
      log(todayLine(sessionsToday(sessions, time)));
      log('Start: atris 99 50   Again: atris 99 again   Help: atris 99 help');
    } else if (action === 'focus' || action === 'meditate') {
      if (active) {
        log('a session is already running; use atris 99 stop first');
        return 1;
      }
      appendRecord(file, text, startRecord(action, Number(rest[0]), time, randomUUID(), intention));
      const end = new Date(time.getTime() + Number(rest[0]) * 60000);
      log(`${kindName(action)} ${rest[0]} started. Ends at ${localEndTime(end)}.`);
      if (action === 'focus' && !intention && suggestion) {
        // The timer has started; the hint never delays it and a failure prints nothing.
        const hint = suggestion(time);
        const show = (line) => {
          const text = oneLine(line, 120);
          if (text) log(`Suggestion: ${text}`);
          return 0;
        };
        if (hint && typeof hint.then === 'function') return hint.then(show, () => 0);
        show(hint);
      }
    } else if (action === 'pause' || action === 'resume') {
      if (!active) {
        log('Nothing running. Start one: atris 99 50');
        return 1;
      }
      if (action === 'pause' && active.status === 'paused') {
        log('Already paused. Resume: atris 99 resume');
        return 1;
      }
      if (action === 'resume' && active.status !== 'paused') {
        log('Not paused.');
        return 1;
      }
      const record = action === 'pause' ? pauseRecord(active, time) : resumeRecord(active, time);
      appendRecord(file, text, record);
      if (action === 'pause') log(`Paused. ${timeLeft(active, time)} left.`);
      else {
        const end = new Date(Date.parse(active.planned_end_at) + time.getTime() - Date.parse(active.paused_at));
        log(`Resumed. Ends at ${localEndTime(end)}.`);
      }
    } else if (action === 'status') {
      const result = sessionStatus(active, time);
      if (json) log(JSON.stringify(result));
      else if (!active) log('nothing running');
      else log(runningLine(active, time));
    } else {
      const result = sessionsToday(sessions, time);
      const health = healthToday(records, time);
      if (health) result.health_day = health;
      const blocks = blocksToday(sessions, time);
      result.deep_work = { block_count: blocks.count, block_minutes: blocks.minutes };
      if (json) log(JSON.stringify(result));
      else {
        log(todayLine(result));
        const line = blocksLine(blocks);
        if (line) log(`Deep work: ${line}`);
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
