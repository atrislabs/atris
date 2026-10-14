'use strict';

// Live progress for a working member: one plain line per tool step, printed to
// stderr and appended to <dir>/<member>.log so another shell can tail it.

const fs = require('fs');
const os = require('os');
const path = require('path');

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
      return `running: ${cutCommand(first)}`;
    }
    case 'Grep':
      return `searching for ${input.pattern || ''}`;
    case 'Glob':
      return `finding ${input.pattern || ''}`;
    default:
      return name.toLowerCase();
  }
}

// A command past 70 chars is cut and says so, the way a long line is, so the
// board does not show half a command as if it ended there.
function cutCommand(command) {
  return command.length > 70 ? `${command.slice(0, 70)}...` : command;
}

// Codex wraps each command in a login shell ("/bin/zsh -lc 'grep -n x a.txt'");
// the line shows only what ran inside it.
function unwrapShellCommand(command) {
  const text = String(command || '').trim();
  const match = text.match(/^(?:\S*\/)?(?:ba|z)?sh\s+-l?c\s+(['"])([\s\S]*)\1$/);
  return match ? match[2] : text;
}

// A quoted pattern is one argument even with spaces in it ("rg -n 'two words'
// lib" searches for two words, not 'two), and one the line cut before its
// closing quote keeps what is there. A flag's value ("rg -g '*.js' needle")
// is not the pattern, and -e names the pattern outright.
const SEARCH_VALUE_FLAGS = {
  rg: { short: 'fgtTmABCMjd', long: ['file', 'glob', 'iglob', 'type', 'type-not', 'max-count', 'after-context', 'before-context', 'context', 'max-columns', 'threads', 'max-depth'] },
  grep: { short: 'fmABCdD', long: ['file', 'max-count', 'after-context', 'before-context', 'context', 'include', 'exclude', 'exclude-dir', 'directories', 'devices'] },
};
function searchPattern(command) {
  const [tool, ...words] = [...command.matchAll(/'([^']*)'?|"((?:[^"\\]|\\.)*)"?|(\S+)/g)]
    .map((m) => (m[3] !== undefined ? m[3] : m[1] !== undefined ? m[1] : m[2].replace(/\\(.)/g, '$1')));
  const takes = SEARCH_VALUE_FLAGS[tool] || { short: '', long: [] };
  for (let i = 0; i < words.length; i += 1) {
    const w = words[i];
    if (w === '--') return words[i + 1] || '';
    if (w === '--regexp' || /^-[A-Za-z]*e$/.test(w)) return words[i + 1] || '';
    if (w.startsWith('--')) { if (takes.long.includes(w.slice(2))) i += 1; continue; }
    // A bundle like -nC takes a value when its last letter does.
    if (/^-[A-Za-z]+$/.test(w)) { if (takes.short.includes(w.slice(-1))) i += 1; continue; }
    if (w && !w.startsWith('-')) return w;
  }
  return '';
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
      return `running: ${cutCommand(first)}`;
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
    fs.appendFileSync(path.join(dir, `${safeMember(member)}.log`), entry, 'utf8');
  } catch {}
}

// Print one step for the operator and keep it in the member's progress log.
function reportProgress(member, line, missionId) {
  const short = shortenLine(line);
  try { process.stderr.write(`  ${member || 'mission'} ${hhmm()}  ${short}\n`); } catch {}
  appendProgress(member, short, missionId);
}

module.exports = { formatToolStep, formatCodexEvent, appendProgress, reportProgress, shortenLine, startedLine, RUN_TAG, newRunToken, runMarker };
