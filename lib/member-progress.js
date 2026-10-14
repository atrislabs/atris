'use strict';

// Live progress for a working member: one plain line per tool step, printed to
// stderr and appended to <dir>/<member>.log so another shell can tail it.

const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_PROGRESS_BYTES = 256 * 1024;
const KEEP_PROGRESS_BYTES = 128 * 1024;

// Progress is a live view, not the durable mission receipt. Keep whole recent
// lines and the latest start marker so the board still knows the job and pid.
// Scan backwards in bounded chunks even when upgrading a very large old log.
function trimProgress(file) {
  const fd = fs.openSync(file, 'r');
  let recent;
  let started = '';
  try {
    const size = fs.fstatSync(fd).size;
    if (size <= MAX_PROGRESS_BYTES) return;
    const from = Math.max(0, size - KEEP_PROGRESS_BYTES);
    const tail = Buffer.alloc(size - from);
    fs.readSync(fd, tail, 0, tail.length, from);
    recent = tail.subarray(from ? tail.indexOf(0x0a) + 1 : 0).toString('utf8');
    let end = size;
    let partial = Buffer.alloc(0);
    while (end > 0 && !started) {
      const begin = Math.max(0, end - KEEP_PROGRESS_BYTES);
      const chunk = Buffer.alloc(end - begin);
      fs.readSync(fd, chunk, 0, chunk.length, begin);
      const combined = Buffer.concat([chunk, partial]);
      const boundary = begin ? combined.indexOf(0x0a) : -1;
      partial = begin ? combined.subarray(0, boundary < 0 ? combined.length : boundary) : Buffer.alloc(0);
      const lines = combined.subarray(begin ? boundary < 0 ? combined.length : boundary + 1 : 0).toString('utf8').split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        if (/^\S+ \S+ started:/.test(lines[i])) { started = lines[i].slice(0, 500); break; }
      }
      // Malformed legacy lines must not make the backwards scan unbounded.
      if (partial.length > KEEP_PROGRESS_BYTES) partial = Buffer.alloc(0);
      end = begin;
    }
  } finally { fs.closeSync(fd); }
  const prefix = started && !recent.includes(`${started}\n`) ? `${started}\n` : '';
  const tmp = `${file}.${process.pid}.${newRunToken()}.tmp`;
  try {
    fs.writeFileSync(tmp, prefix + recent, 'utf8');
    fs.renameSync(tmp, file);
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

function realish(p) {
  try { return fs.realpathSync(p); } catch {}
  try { return path.join(fs.realpathSync(path.dirname(p)), path.basename(p)); } catch {}
  return p;
}

function insideRel(cwd, p) {
  const rel = path.relative(cwd, p);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : null;
}

// Relative to cwd when inside it; symlinked roots (macOS /var vs /private/var)
// still count as inside.
function relativeTo(cwd, file) {
  const p = String(file || '');
  if (!p || !cwd || !path.isAbsolute(p)) return p;
  return insideRel(cwd, p) || insideRel(realish(cwd), realish(p)) || p;
}

function formatToolStep(block, cwd) {
  if (!block || block.type !== 'tool_use') return null;
  const name = String(block.name || 'tool');
  const input = block.input || {};
  switch (name) {
    case 'Read':
      return `reading ${relativeTo(cwd, input.file_path)}`;
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
      return `editing ${relativeTo(cwd, input.file_path)}`;
    case 'Bash': {
      const first = String(input.command || '').split('\n')[0].trim();
      return `running: ${first.slice(0, 70)}`;
    }
    case 'Grep':
      return `searching for ${input.pattern || ''}`;
    case 'Glob':
      return `finding ${input.pattern || ''}`;
    default:
      return name.toLowerCase();
  }
}

// Codex wraps each command in a login shell ("/bin/zsh -lc 'grep -n x a.txt'");
// the line shows only what ran inside it.
function unwrapShellCommand(command) {
  const text = String(command || '').trim();
  const match = text.match(/^(?:\S*\/)?(?:ba|z)?sh\s+-l?c\s+(['"])([\s\S]*)\1$/);
  return match ? match[2] : text;
}

function searchPattern(command) {
  const words = command.split(/\s+/).slice(1);
  const word = words.find((w) => w && !w.startsWith('-')) || '';
  return word.replace(/^(['"])(.*)\1$/, '$2');
}

// One plain line for a codex `exec --json` event, or null when the event is
// not a step (messages, reasoning, turn bookkeeping). Commands show when they
// start; file edits only arrive once done.
function formatCodexEvent(event, cwd) {
  if (!event || (event.type !== 'item.started' && event.type !== 'item.completed')) return null;
  const item = event.item || {};
  switch (item.type) {
    case 'command_execution': {
      const first = unwrapShellCommand(item.command).split('\n')[0].trim();
      if (/^(rg|grep)\s/.test(first)) return `searching for ${searchPattern(first)}`;
      return `running: ${first.slice(0, 70)}`;
    }
    case 'file_change': {
      const files = (Array.isArray(item.changes) ? item.changes : [])
        .map((change) => relativeTo(cwd, change && change.path))
        .filter(Boolean);
      return files.length ? `editing ${files.join(', ')}` : null;
    }
    case 'web_search':
      return `searching for ${item.query || ''}`;
    default:
      return null;
  }
}

function progressDir() {
  return process.env.ATRIS_PROGRESS_DIR || path.join(os.homedir(), '.atris', 'progress');
}

function safeMember(member) {
  return String(member || 'mission').replace(/[^A-Za-z0-9._-]/g, '_') || 'mission';
}

function hhmm(date = new Date()) {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

// A started line can name the run's process and engine up front:
// "started: [pid 4242 engine claude] <objective>". The board reads the pid to
// tell a live run from a dead one, and `atris member stop` kills its group.
const RUN_TAG = /^\[pid (\d+)(?: engine (\S+))?(?: run ([0-9a-f]{16}))?\]\s*/;

function startedLine(objective, { pid, engine, run } = {}) {
  const runPart = /^[0-9a-f]{16}$/.test(String(run || '')) ? ` run ${run}` : '';
  const tag = Number.isInteger(pid) && pid > 0 ? `[pid ${pid}${engine ? ` engine ${engine}` : ''}${runPart}] ` : '';
  return `started: ${tag}${objective || ''}`;
}

// How a run ended, with the reason the board shows on a failed row:
// "finished: failed (timed out)". A timeout or stop kills the engine, so it
// names the cause before the exit code that kill produced.
function finishedLine({ ok, timedOut, aborted, engineError, code, exitSignal } = {}) {
  if (ok) return 'finished: ok';
  let why = '';
  if (timedOut) why = 'timed out';
  else if (aborted) why = 'stopped';
  else if (engineError) why = 'engine error';
  else if (Number.isInteger(code) && code !== 0) why = `bad exit ${code}`;
  else if (exitSignal) why = `killed by ${exitSignal}`;
  return `finished: failed${why ? ` (${why})` : ''}`;
}

// A one-time token for one engine run. It goes on the first line of the
// engine's prompt (visible in its command line) and in the started line, so
// member stop can prove a live process is that member's run.
function newRunToken() {
  return require('crypto').randomBytes(8).toString('hex');
}

function runMarker(member, token) {
  return `atris-run ${member} ${token}`;
}

// One progress line stays one short line: a 'started:' objective keeps its
// first line and at most 80 chars (the run tag does not count); any other
// line caps at 100.
function shortenLine(line) {
  const first = String(line || '').split('\n')[0];
  if (first.startsWith('started: ')) {
    const body = first.slice('started: '.length);
    const tag = (RUN_TAG.exec(body) || [''])[0];
    const objective = body.slice(tag.length);
    return `started: ${tag}${objective.length > 80 ? `${objective.slice(0, 80)}...` : objective}`;
  }
  return first.length > 100 ? `${first.slice(0, 100)}...` : first;
}

function appendProgress(member, line, missionId) {
  // Test runs never write into the real home folder unless they name a dir.
  if (!process.env.ATRIS_PROGRESS_DIR && process.env.NODE_TEST_CONTEXT) return;
  try {
    const dir = progressDir();
    fs.mkdirSync(dir, { recursive: true });
    const entry = `${new Date().toISOString()} ${missionId || '-'} ${shortenLine(line)}\n`;
    const file = path.join(dir, `${safeMember(member)}.log`);
    fs.appendFileSync(file, entry, 'utf8');
    trimProgress(file);
  } catch {}
}

// Print one step for the operator and keep it in the member's progress log.
function reportProgress(member, line, missionId) {
  const short = shortenLine(line);
  try { process.stderr.write(`  ${member || 'mission'} ${hhmm()}  ${short}\n`); } catch {}
  appendProgress(member, short, missionId);
}

module.exports = { formatToolStep, formatCodexEvent, appendProgress, reportProgress, shortenLine, startedLine, finishedLine, RUN_TAG, newRunToken, runMarker };
