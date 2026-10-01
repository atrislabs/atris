'use strict';

// Who is working right now: engine runs alive on this machine, read from one
// `ps` call. A run belongs to a member when its prompt says "acting as
// <member>" (the dispatch convention); otherwise it shows as unattached.
// Nothing here starts or stops anything.

const path = require('path');
const { spawnSync } = require('child_process');

const { engineModelText } = require('./roster-models');

const PS_ARGS = ['-axo', 'pid=,ppid=,etime=,command='];

// The tool at the front of a command and what it needs to count as a
// headless run. Interactive sessions (a bare `codex`, `claude` without -p)
// are a person at a terminal, not a dispatched run.
const ENGINE_RULES = Object.freeze({
  codex: (args) => args[0] === 'exec',
  claude: (args) => args.includes('-p') || args.includes('--print'),
  devin: (args) => args.includes('-p') || args.includes('--print'),
  'cursor-agent': () => true,
  grok: () => true,
  agy: () => true,
  opencode: (args) => args[0] === 'run',
  atris: (args) => args[0] === 'engine' && ['ask', 'dispatch', 'validate', 'bench', 'test'].includes(args[1]),
});

const INTERPRETERS = new Set(['node', 'bun', 'deno']);

// Flags that take the next word as their value, across the engine CLIs.
const VALUE_FLAGS = new Set([
  '-m', '--model', '-o', '--output-last-message', '--cd', '-C', '-c', '--config', '-s', '--sandbox',
  '--permission-mode', '--prompt-file', '--output-format', '--input-format', '--add-dir', '--profile',
  '--effort', '--max-turns', '--allowedTools', '--allowed-tools', '--disallowedTools', '--append-system-prompt',
  '--system-prompt', '--session-id', '--resume', '--engine', '--image', '-i', '--color', '--agent', '--mode',
]);

function engineOf(token) {
  const base = path.basename(String(token || '')).replace(/\.(c?js|mjs)$/, '');
  if (base === 'atris') return 'atris';
  // The native codex binary can carry a platform suffix.
  if (/^codex(-[a-z0-9_-]+)?$/.test(base)) return 'codex';
  return Object.prototype.hasOwnProperty.call(ENGINE_RULES, base) ? base : '';
}

// "1-02:03:04", "02:03:04", "03:04" -> seconds.
function parseElapsed(text) {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(String(text || '').trim());
  if (!match) return null;
  const [, days, hours, minutes, seconds] = match.map((part) => Number(part || 0));
  return days * 86400 + hours * 3600 + minutes * 60 + seconds;
}

// "now", "6m", "2h", "3d".
function shortElapsed(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value < 0) return '-';
  if (value < 60) return 'now';
  if (value < 3600) return `${Math.floor(value / 60)}m`;
  if (value < 86400) return `${Math.floor(value / 3600)}h`;
  return `${Math.floor(value / 86400)}d`;
}

function parsePsLine(line) {
  const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(String(line || ''));
  if (!match) return null;
  return { pid: Number(match[1]), ppid: Number(match[2]), elapsed_seconds: parseElapsed(match[3]), command: match[4] };
}

function flagValue(args, names) {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    for (const name of names) {
      if (arg === name && args[i + 1] !== undefined) return args[i + 1];
      if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
    }
  }
  return '';
}

function effortOf(args) {
  const direct = flagValue(args, ['--effort']);
  if (direct) return direct;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] !== '-c' && args[i] !== '--config') continue;
    const match = /^model_reasoning_effort=["']?([a-z]+)/.exec(String(args[i + 1] || ''));
    if (match) return match[1];
  }
  return '';
}

// The prompt: everything after "--", else from the first word that is not a
// flag, a flag's value, or the subcommand.
function promptOf(args, engine) {
  const dash = args.indexOf('--');
  if (dash !== -1) return args.slice(dash + 1).join(' ');
  let i = 0;
  if (engine === 'codex' || engine === 'opencode') i = 1;
  if (engine === 'atris') i = 2;
  for (; i < args.length; i += 1) {
    const arg = args[i];
    if (arg.startsWith('-')) {
      if (!arg.includes('=') && VALUE_FLAGS.has(arg)) i += 1;
      continue;
    }
    return args.slice(i).join(' ');
  }
  const file = flagValue(args, ['--prompt-file']);
  return file ? `prompt file ${path.basename(file)}` : '';
}

// A prompt can run to pages; the view needs its first line.
const DOING_MAX = 240;

const MEMBER_PATTERN = /\bacting as (?:the )?([a-z0-9][a-z0-9_-]*[a-z0-9])/i;

// "You are acting as validator. Review the diff" -> "Review the diff".
function doingText(prompt, member) {
  let text = String(prompt || '').replace(/\\0?12|\\n/g, ' ').replace(/\s+/g, ' ').trim();
  if (member) {
    const at = text.search(MEMBER_PATTERN);
    if (at !== -1) {
      const after = text.slice(at).replace(MEMBER_PATTERN, '').replace(/^[\s.,:;-]+/, '').trim();
      if (after) text = after;
    }
  }
  // The dispatch preamble ("Read <path>/MEMBER.md first.") says nothing
  // about the work.
  text = text.replace(/^(?:first,?\s+)?read\s+\S+\s+first[.,]?\s*/i, '');
  return text.length > DOING_MAX ? `${text.slice(0, DOING_MAX - 1).trimEnd()}…` : text;
}

// One ps line -> a run, or null when it is not a headless engine run.
function parseEngineProcess(entry) {
  if (!entry || !entry.command) return null;
  if (/orchestrator/i.test(entry.command)) return null;
  const tokens = entry.command.trim().split(/\s+/);
  let at = 0;
  if (INTERPRETERS.has(path.basename(tokens[0] || ''))) at = 1;
  const engine = engineOf(tokens[at]);
  if (!engine) return null;
  const args = tokens.slice(at + 1);
  if (!ENGINE_RULES[engine](args)) return null;
  const memberMatch = MEMBER_PATTERN.exec(entry.command.replace(/\\0?12/g, ' '));
  const member = memberMatch ? memberMatch[1].toLowerCase() : null;
  const model = flagValue(args, ['-m', '--model']);
  const prompt = promptOf(args, engine);
  return {
    pid: entry.pid,
    ppid: entry.ppid,
    engine,
    model: model || null,
    effort: effortOf(args) || null,
    member,
    doing: doingText(prompt, member) || '-',
    elapsed_seconds: entry.elapsed_seconds,
    args: args.join(' '),
  };
}

// Every matched run above this one in the process tree. A shell may sit
// between a dispatcher and the tool it runs, so the walk goes all the way up.
function matchedAncestors(run, all, byPid) {
  const out = [];
  const seen = new Set();
  let pid = run.ppid;
  while (all.has(pid) && !seen.has(pid)) {
    seen.add(pid);
    if (byPid.has(pid)) out.push(byPid.get(pid));
    pid = all.get(pid).ppid;
  }
  return out;
}

// Keep one run per real job. A node wrapper and the native binary it spawns
// carry the same words, and a dispatcher (atris engine) sits above the tool
// it runs: the deepest run wins, and an unnamed run takes the member of the
// nearest named run above it.
function liveEngineRuns(entries, { selfPid = process.pid } = {}) {
  const all = new Map(entries.filter(Boolean).map((entry) => [entry.pid, entry]));
  const runs = entries
    .filter((entry) => entry && entry.pid !== selfPid)
    .map(parseEngineProcess)
    .filter(Boolean);
  const byPid = new Map(runs.map((run) => [run.pid, run]));
  const above = new Map(runs.map((run) => [run.pid, matchedAncestors(run, all, byPid)]));
  for (const run of runs) {
    if (run.member) continue;
    const named = above.get(run.pid).find((item) => item.member);
    if (named) run.member = named.member;
  }
  const hidden = new Set();
  for (const run of runs) {
    for (const item of above.get(run.pid)) {
      if (!item.member || item.member === run.member) hidden.add(item.pid);
    }
  }
  const seen = new Set();
  const kept = [];
  for (const run of runs) {
    if (hidden.has(run.pid)) continue;
    const key = `${run.engine}\u0000${run.args}`;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(run);
  }
  return kept
    .map(({ args, ppid, ...run }) => run)
    .sort((a, b) => (a.elapsed_seconds ?? Infinity) - (b.elapsed_seconds ?? Infinity));
}

// The live runs on this machine. deps.runPs returns { status, stdout } like
// spawnSync; tests pass their own. A ps that fails means no runs, never an
// error.
function listLiveEngineRuns(deps = {}) {
  const run = deps.runPs || (() => spawnSync('ps', PS_ARGS, { encoding: 'utf8', timeout: 3000, maxBuffer: 16 * 1024 * 1024 }));
  let result;
  try { result = run(PS_ARGS); } catch { return []; }
  if (!result || result.status !== 0 || typeof result.stdout !== 'string') return [];
  const entries = result.stdout.split(/\r?\n/).map(parsePsLine).filter(Boolean);
  return liveEngineRuns(entries, { selfPid: deps.selfPid || process.pid });
}

// "codex · gpt-6.1-sol" for a live run.
function liveRunEngineText(run) {
  return (run && engineModelText(run.engine, run.model || '')) || '-';
}

module.exports = {
  listLiveEngineRuns,
  liveEngineRuns,
  liveRunEngineText,
  parseEngineProcess,
  parsePsLine,
  shortElapsed,
};
