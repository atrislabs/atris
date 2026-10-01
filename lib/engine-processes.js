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
  // Atris Fast and Composer launch `ax --fast <prompt>`. A chat, doctor or
  // approvals call is a person at a terminal, and needs a message to count.
  'atris-fast': (args) => !args.some((arg) => AX_CONTROL_FLAGS.has(arg.split('=')[0])) && Boolean(promptOf(args, 'atris-fast')),
  // Command Code launches `cmd -p <prompt>`.
  commandcode: (args) => args.includes('-p') || args.includes('--print'),
});

// The command a runner profile launches -> the engine name the roster uses.
const BINARY_ENGINES = Object.freeze({ ax: 'atris-fast', cmd: 'commandcode' });

const AX_CONTROL_FLAGS = new Set([
  '--chat', '--doctor', '--approvals', '--approve', '--deny', '--grant', '--grants', '--sync-grants',
  '--revoke-grant', '--auto-approve', '--self-test', '--benchmark', '--help', '-h', '--version',
]);

// ax picks its model by mode flag; --fast is the atris-fast profile's model.
const AX_MODES = ['auto', 'max', 'pro', 'fast', 'rapid', 'alpha', 'code-fast'];

const INTERPRETERS = new Set(['node', 'bun', 'deno']);

// Flags that take the next word as their value, across the engine CLIs.
const VALUE_FLAGS = new Set([
  '-m', '--model', '-o', '--output-last-message', '--cd', '-C', '-c', '--config', '-s', '--sandbox',
  '--permission-mode', '--prompt-file', '--output-format', '--input-format', '--add-dir', '--profile',
  '--effort', '--max-turns', '--allowedTools', '--allowed-tools', '--disallowedTools', '--append-system-prompt',
  '--system-prompt', '--session-id', '--resume', '--engine', '--image', '-i', '--color', '--agent', '--mode',
  '--business', '--verify',
]);

function engineOf(token) {
  const base = path.basename(String(token || '')).replace(/\.(c?js|mjs)$/, '');
  if (base === 'atris') return 'atris';
  // The native codex binary can carry a platform suffix.
  if (/^codex(-[a-z0-9_-]+)?$/.test(base)) return 'codex';
  if (Object.prototype.hasOwnProperty.call(BINARY_ENGINES, base)) return BINARY_ENGINES[base];
  // Command Code run straight from its package file.
  if (/[\\/]command-code[\\/]dist[\\/]index\.m?js$/.test(String(token || ''))) return 'commandcode';
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

// The words before the prompt: up to "--", or up to the first word that is
// not a flag, a flag's value, or the subcommand. Flag-looking words inside a
// prompt ("Fix --model parsing") are the prompt, not settings.
function promptStart(args, engine) {
  const dash = args.indexOf('--');
  let i = 0;
  if (engine === 'codex' || engine === 'opencode') i = 1;
  if (engine === 'atris') i = 2;
  const end = dash === -1 ? args.length : dash;
  for (; i < end; i += 1) {
    const arg = args[i];
    if (!arg.startsWith('-')) return { options: args.slice(0, i), prompt: args.slice(i) };
    if (!arg.includes('=') && VALUE_FLAGS.has(arg)) i += 1;
  }
  return { options: args.slice(0, end), prompt: dash === -1 ? [] : args.slice(dash + 1) };
}

// Atris launches claude as `claude -p <prompt> --model <id> [--effort <level>]
// [--allowedTools <list>]`, settings after the prompt. That tail counts only
// in exactly that shape, with a real model id and effort word, so a prompt
// ending "Fix --model parsing" keeps its words.
const CLAUDE_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const CLAUDE_TAIL = /\s--model\s+((?:claude-|opus|sonnet|haiku|fable)[a-z0-9.\-[\]]*)(?:\s+--effort\s+([a-z]+))?(?:\s+--allowedTools\s+.*)?$/i;

function claudeTail(prompt) {
  const match = CLAUDE_TAIL.exec(` ${prompt}`);
  if (!match || (match[2] && !CLAUDE_EFFORTS.has(match[2].toLowerCase()))) return null;
  return { model: match[1], effort: match[2] || '', prompt: ` ${prompt}`.slice(0, match.index).trim() };
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
  const { options, prompt } = promptStart(args, engine);
  if (prompt.length) {
    const text = prompt.join(' ');
    const tail = engine === 'claude' ? claudeTail(text) : null;
    return tail ? tail.prompt : text;
  }
  const file = flagValue(options, ['--prompt-file']);
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

function axModel(engine, options) {
  if (engine !== 'atris-fast') return '';
  const mode = AX_MODES.find((name) => options.includes(`--${name}`));
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
  const args = tokens.slice(at + 1);
  if (!ENGINE_RULES[engine](args)) return null;
  const memberMatch = MEMBER_PATTERN.exec(entry.command.replace(/\\0?12/g, ' '));
  const member = memberMatch ? memberMatch[1].toLowerCase() : null;
  const { options, prompt: promptWords } = promptStart(args, engine);
  const tail = engine === 'claude' ? claudeTail(promptWords.join(' ')) : null;
  const prompt = promptOf(args, engine);
  const model = flagValue(options, ['-m', '--model']) || (tail && tail.model) || axModel(engine, options);
  return {
    pid: entry.pid,
    ppid: entry.ppid,
    engine,
    model: model || null,
    effort: effortOf(options) || (tail && tail.effort) || null,
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
  shortElapsed,
};
