'use strict';

// Who is working right now: engine runs alive on this machine, read from one
// `ps` call. A run belongs to a member when its prompt says "acting as
// <member>" (the dispatch convention); otherwise it shows as unattached.
// Nothing here starts or stops anything.

const path = require('path');
const { spawnSync } = require('child_process');

const { engineModelText } = require('./roster-models');
const { EFFORT_WORDS } = require('./runner-command');

const PS_ARGS = ['-axo', 'pid=,ppid=,etime=,command='];

// Each engine CLI: how many words of subcommand lead its arguments, which
// of its flags take the next word as a value, and what makes a launch a
// headless run rather than a person at a terminal. Every check reads only the
// settings before the prompt (see splitArgs), never the prompt itself.
const COMMON_VALUES = ['-m', '--model', '--effort', '--add-dir', '--prompt-file'];
const CLAUDE_VALUES = [
  '--permission-mode', '--output-format', '--input-format', '--allowedTools', '--allowed-tools',
  '--disallowedTools', '--disallowed-tools', '--append-system-prompt', '--system-prompt', '--session-id',
  '--resume', '-r', '--max-turns', '--mcp-config', '--settings', '--agents', '--fallback-model',
];
const AX_CONTROL_FLAGS = new Set([
  '--chat', '--doctor', '--approvals', '--approve', '--deny', '--grant', '--grants', '--sync-grants',
  '--revoke-grant', '--auto-approve', '--self-test', '--benchmark', '--help', '-h', '--version',
]);
const ATRIS_RUN_VERBS = ['ask', 'dispatch', 'validate', 'bench', 'test'];

const printing = ({ flags }) => hasFlag(flags, ['-p', '--print']);

const ENGINES = Object.freeze({
  codex: {
    command: 1,
    values: ['-c', '--config', '-s', '--sandbox', '-o', '--output-last-message', '-C', '--cd', '-p', '--profile',
      '-i', '--image', '--color', '--output-schema', '-a', '--ask-for-approval', '--enable', '--disable'],
    headless: ({ command }) => command[0] === 'exec',
  },
  claude: { values: CLAUDE_VALUES, headless: printing },
  devin: { values: ['--permission-mode'], headless: printing },
  'cursor-agent': { values: ['--output-format', '--api-key', '--resume'], headless: printing },
  grok: { values: [], headless: printing },
  agy: { values: ['--mode'], headless: printing },
  opencode: {
    command: 1,
    values: ['--variant', '--agent', '-s', '--session', '--format', '-f', '--file'],
    headless: ({ command }) => command[0] === 'run',
  },
  atris: {
    command: 2,
    values: ['--engine', '--member', '--minutes', '--job'],
    headless: ({ command }) => command[0] === 'engine' && ATRIS_RUN_VERBS.includes(command[1]),
  },
  // Atris Fast and Composer launch `ax --fast <prompt>`. A chat, doctor or
  // approvals call is a person at a terminal, and a run needs a message.
  'atris-fast': {
    values: ['--business', '--verify', '--approve', '--deny', '--grant', '--revoke-grant'],
    headless: ({ flags, prompt }) => !flags.some(([name]) => AX_CONTROL_FLAGS.has(name)) && prompt.length > 0,
  },
  // Command Code launches `cmd -p <prompt>`.
  commandcode: { values: [], headless: printing },
});
for (const spec of Object.values(ENGINES)) spec.values = new Set([...COMMON_VALUES, ...spec.values]);

// The command a runner profile launches -> the engine name the roster uses.
const BINARY_ENGINES = Object.freeze({ ax: 'atris-fast', cmd: 'commandcode' });

// ax picks its model by mode flag; --fast is the atris-fast profile's model.
const AX_MODES = ['auto', 'max', 'pro', 'fast', 'rapid', 'alpha', 'code-fast'];

const INTERPRETERS = new Set(['node', 'bun', 'deno']);

function engineOf(token) {
  const base = path.basename(String(token || '')).replace(/\.(c?js|mjs)$/, '');
  if (base === 'atris') return 'atris';
  // The native codex binary can carry a platform suffix.
  if (/^codex(-[a-z0-9_-]+)?$/.test(base)) return 'codex';
  if (Object.prototype.hasOwnProperty.call(BINARY_ENGINES, base)) return BINARY_ENGINES[base];
  // Command Code run straight from its package file.
  if (/[\\/]command-code[\\/]dist[\\/]index\.m?js$/.test(String(token || ''))) return 'commandcode';
  return Object.prototype.hasOwnProperty.call(ENGINES, base) ? base : '';
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

// The one place a launch is split. argv -> the subcommand words, the
// settings (flags and their values), and the prompt. Settings stop at "--"
// or at the first word that is neither a flag nor a flag's value; everything
// after is the prompt, so "Fix --model parsing" or "Explain the -p flag" is
// prompt text, never a setting.
function splitArgs(engine, args) {
  const spec = ENGINES[engine];
  const command = args.slice(0, spec.command || 0);
  const flags = [];
  let i = command.length;
  for (; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--') return { command, flags, prompt: args.slice(i + 1), dashed: true };
    if (!arg.startsWith('-') || arg === '-') break;
    const eq = arg.indexOf('=');
    if (arg.startsWith('--') && eq > 0) flags.push([arg.slice(0, eq), arg.slice(eq + 1)]);
    else if (spec.values.has(arg) && i + 1 < args.length) { flags.push([arg, args[i + 1]]); i += 1; }
    else flags.push([arg, true]);
  }
  return { command, flags, prompt: args.slice(i), dashed: false };
}

function hasFlag(flags, names) {
  return flags.some(([name]) => names.includes(name));
}

function flagValue(flags, names) {
  const found = flags.find(([name, value]) => names.includes(name) && typeof value === 'string');
  return found ? found[1] : '';
}

function effortOf(flags) {
  const direct = flagValue(flags, ['--effort']);
  if (direct) return direct;
  for (const [name, value] of flags) {
    if (name !== '-c' && name !== '--config') continue;
    const match = /^model_reasoning_effort=["']?([a-z]+)/.exec(String(value));
    if (match) return match[1];
  }
  return '';
}

// Atris builds its claude launch (buildRunnerCommand in runner-command.js)
// as `claude -p "$(cat <file>)" --model <id> [--effort <word>]
// [--allowedTools <list>]`: settings after the prompt. That tail counts only
// in exactly that shape: -p alone before the prompt, no "--", a claude model,
// a real effort word, in that order, running to the end.
function claudeTail(split) {
  const { flags, prompt, dashed } = split;
  if (dashed || flags.length !== 1 || flags[0][0] !== '-p') return null;
  const { isClaudeFamilyModel } = require('./engine-registry');
  for (let j = 1; j < prompt.length - 1; j += 1) {
    if (prompt[j] !== '--model' || !isClaudeFamilyModel(prompt[j + 1])) continue;
    let k = j + 2;
    let effort = '';
    if (prompt[k] === '--effort') {
      if (!EFFORT_WORDS.includes(prompt[k + 1])) continue;
      effort = prompt[k + 1];
      k += 2;
    }
    if (prompt[k] === '--allowedTools' && k + 1 < prompt.length) k = prompt.length;
    if (k !== prompt.length) continue;
    return { model: prompt[j + 1], effort, prompt: prompt.slice(0, j) };
  }
  return null;
}

function promptText(split) {
  if (split.prompt.length) return split.prompt.join(' ');
  const file = flagValue(split.flags, ['--prompt-file']);
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

function axModel(engine, flags) {
  if (engine !== 'atris-fast') return '';
  const mode = AX_MODES.find((name) => hasFlag(flags, [`--${name}`]));
  return mode ? `atris:${mode}` : '';
}

// One ps line -> a run, or null when it is not a headless engine run.
function parseEngineProcess(entry) {
  if (!entry || !entry.command) return null;
  const tokens = entry.command.trim().split(/\s+/);
  let at = 0;
  if (INTERPRETERS.has(path.basename(tokens[0] || ''))) at = 1;
  // The orchestrator daemon is skipped by what it runs, never by what a
  // prompt mentions ("Review orchestrator.py" is real work).
  if (tokens.slice(0, at + 1).some((token) => /orchestrator/i.test(path.basename(token)))) return null;
  const engine = engineOf(tokens[at]);
  if (!engine) return null;
  let split = splitArgs(engine, tokens.slice(at + 1));
  if (!ENGINES[engine].headless(split)) return null;
  const tail = engine === 'claude' ? claudeTail(split) : null;
  if (tail) split = { ...split, prompt: tail.prompt };
  const prompt = promptText(split);
  const memberMatch = MEMBER_PATTERN.exec(prompt.replace(/\\0?12/g, ' '));
  const member = memberMatch ? memberMatch[1].toLowerCase() : null;
  const model = flagValue(split.flags, ['-m', '--model']) || (tail && tail.model) || axModel(engine, split.flags);
  return {
    pid: entry.pid,
    ppid: entry.ppid,
    engine,
    model: model || null,
    effort: effortOf(split.flags) || (tail && tail.effort) || null,
    member,
    doing: doingText(prompt, member) || '-',
    elapsed_seconds: entry.elapsed_seconds,
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
// nearest named run above it. Only runs in one process line fold together:
// two separate processes asking the same thing are two jobs.
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
  return runs
    .filter((run) => !hidden.has(run.pid))
    .map(({ ppid, ...run }) => run)
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
  splitArgs,
  shortElapsed,
};
