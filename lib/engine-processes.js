'use strict';

// Who is working right now: engine runs alive on this machine, read from one
// `ps` call. A run belongs to a member when its prompt says "acting as
// <member>" (the dispatch convention); otherwise it shows as unattached.
// Nothing here starts or stops anything.
//
// ps joins a launch's words with spaces, so where the prompt starts and ends
// is a guess. The rules: a known engine program is always a row unless it is
// plainly an interactive session; settings are read only where atris's own
// launchers put them (test/roster-team-tables.test.js builds every launch
// from those launchers, so a new flag that breaks this fails a test); and
// when the words cannot be read with confidence the model shows as unknown
// rather than a guess.

const path = require('path');
const { spawnSync } = require('child_process');

const { engineModelText } = require('./roster-models');
const { EFFORT_WORDS } = require('./runner-command');

const PS_ARGS = ['-axo', 'pid=,ppid=,etime=,command='];

// Each engine CLI's settings: the flags that take the next word as a value
// and the flags that stand alone. A flag in neither list makes the reading
// unsure.
const SHARED_VALUES = ['-m', '--model', '--effort', '--add-dir', '--prompt-file', '--output-format'];
const SHARED_SWITCHES = ['-p', '--print', '--help', '-h', '--version', '--verbose', '--json'];

const ENGINE_FLAGS = {
  codex: {
    values: ['-c', '--config', '-s', '--sandbox', '-o', '--output-last-message', '-C', '--cd', '-p', '--profile',
      '-i', '--image', '--color', '--output-schema', '-a', '--ask-for-approval', '--enable', '--disable'],
    switches: ['--ephemeral', '--ignore-user-config', '--ignore-rules', '--dangerously-bypass-approvals-and-sandbox',
      '--skip-git-repo-check', '--full-auto', '--oss'],
  },
  claude: {
    values: ['--tools', '--permission-mode', '--input-format', '--allowedTools', '--allowed-tools', '--disallowedTools',
      '--disallowed-tools', '--append-system-prompt', '--system-prompt', '--session-id', '--resume', '-r', '--max-turns',
      '--mcp-config', '--settings', '--agents', '--fallback-model'],
    switches: ['--no-session-persistence', '--dangerously-skip-permissions', '--safe-mode', '--include-partial-messages',
      '--strict-mcp-config', '-c', '--continue'],
  },
  cursor: {
    values: ['--mode', '--sandbox', '--api-key', '--resume'],
    switches: ['--trust', '--force', '-f', '--stream-partial-output'],
  },
  devin: {
    values: ['--permission-mode', '--respect-workspace-trust'],
    switches: ['--sandbox'],
  },
  grok: {
    values: ['--permission-mode', '--sandbox', '--reasoning-effort', '--best-of-n'],
    switches: ['--always-approve', '--no-memory', '--no-subagents'],
  },
  agy: {
    values: ['--mode', '--print-timeout'],
    switches: ['--sandbox', '--dangerously-skip-permissions'],
  },
  opencode: {
    values: ['--variant', '--agent', '-s', '--session', '--format', '-f', '--file'],
    switches: ['--auto'],
  },
  'atris-fast': {
    values: ['--business', '--verify', '--approve', '--deny', '--grant', '--revoke-grant'],
    switches: ['--auto', '--max', '--pro', '--fast', '--rapid', '--alpha', '--code-fast', '--local', '--cloud', '--chat',
      '--doctor', '--approvals', '--grants', '--sync-grants', '--auto-approve', '--self-test', '--benchmark'],
  },
  commandcode: {
    values: [],
    switches: ['--yolo', '--trust'],
  },
  atris: {
    values: ['--engine', '--member', '--minutes', '--job', '--timeout', '--jobs', '--scope'],
    switches: ['--personal'],
  },
};
for (const spec of Object.values(ENGINE_FLAGS)) {
  spec.values = new Set([...SHARED_VALUES, ...spec.values]);
  spec.switches = new Set([...SHARED_SWITCHES, ...spec.switches]);
}

const AX_CONTROL_FLAGS = new Set([
  '--chat', '--doctor', '--approvals', '--approve', '--deny', '--grant', '--grants', '--sync-grants',
  '--revoke-grant', '--auto-approve', '--self-test', '--benchmark', '--help', '-h', '--version',
]);
const ATRIS_RUN_VERBS = ['ask', 'dispatch', 'validate', 'bench', 'test'];

const printing = ({ flags }) => hasFlag(flags, ['-p', '--print']);

// What makes a launch a run. Where an interactive session looks different
// from a headless one (codex exec, claude -p) the difference is required;
// anywhere else a launch with work in it is a run. A string names the engine
// when the launcher is atris itself.
const RUN_RULES = {
  codex: ({ command }) => command[0] === 'exec',
  claude: printing,
  // `atris agent spawn` launches `cursor-agent <prompt>` with no -p.
  cursor: (split) => printing(split) || split.prompt.length > 0,
  devin: printing,
  grok: printing,
  agy: printing,
  opencode: ({ command }) => command[0] === 'run',
  'atris-fast': ({ flags, prompt }) => !flags.some(([name]) => AX_CONTROL_FLAGS.has(name)) && prompt.length > 0,
  commandcode: printing,
  atris: atrisRunEngine,
};

// Subcommand words ahead of the settings.
function subcommandCount(engine, args) {
  if (engine === 'codex' || engine === 'opencode') return 1;
  if (engine === 'atris') return args[0] === 'engine' ? 2 : 1;
  return 0;
}

// `atris engine ask|dispatch|validate ...` runs the engine it names;
// `atris engine fable <question>` asks fable; `atris chat --print` is Atris
// Fast. Anything else atris does is not an engine run.
function atrisRunEngine({ command, flags, prompt }) {
  if (command[0] === 'chat') return printing({ flags }) && prompt.length > 0 ? 'atris-fast' : false;
  if (command[0] !== 'engine') return false;
  const named = canonicalEngine(flagValue(flags, ['--engine']));
  if (ATRIS_RUN_VERBS.includes(command[1])) return named || 'atris';
  return canonicalEngine(command[1]) || false;
}

function canonicalEngine(name) {
  if (!name) return '';
  const { canonicalEngineName } = require('./engine-registry');
  try { return canonicalEngineName(name) || ''; } catch { return ''; }
}

// The program at the front of a launch -> the engine name the roster uses.
const BINARY_ENGINES = Object.freeze({
  claude: 'claude', 'cursor-agent': 'cursor', devin: 'devin', grok: 'grok', agy: 'agy', opencode: 'opencode',
  ax: 'atris-fast', cmd: 'commandcode', atris: 'atris',
});

// ax picks its model by mode flag; --fast is the atris-fast profile's model.
const AX_MODES = ['auto', 'max', 'pro', 'fast', 'rapid', 'alpha', 'code-fast'];

const INTERPRETERS = new Set(['node', 'bun', 'deno']);

function engineOf(token) {
  const text = String(token || '');
  const base = path.basename(text).replace(/\.(c?js|mjs)$/, '');
  // The native codex binary can carry a platform suffix; codex-watchdog is
  // atris's wrapper, not codex.
  if (/^codex(-(?:aarch64|arm64|x86_64|x64)[a-z0-9_-]*)?$/.test(base)) return 'codex';
  if (Object.prototype.hasOwnProperty.call(BINARY_ENGINES, base)) return BINARY_ENGINES[base];
  // Command Code run straight from its package file.
  if (/[\\/]command-code[\\/]dist[\\/]index\.m?js$/.test(text)) return 'commandcode';
  return '';
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
// settings before the prompt, the prompt, and the settings after it.
// Leading settings stop at "--" or at the first word that is neither a flag
// nor a flag's value. Atris puts some settings after the prompt (claude
// --model, devin --model, fleet's sandbox flags); those count only when every
// word to the end is a known setting, any model named is a real model id, and
// there was no "--". `unsure` is set when a flag the engine list does not
// know came before the prompt, so its value could not be told from prose.
function splitArgs(engine, args) {
  const spec = ENGINE_FLAGS[engine];
  const command = args.slice(0, subcommandCount(engine, args));
  const flags = [];
  let unsure = false;
  let i = command.length;
  for (; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--') return { command, flags, prompt: args.slice(i + 1), dashed: true, unsure, tail: [] };
    if (!arg.startsWith('-') || arg === '-') break;
    const eq = arg.indexOf('=');
    if (arg.startsWith('--') && eq > 0) {
      flags.push([arg.slice(0, eq), arg.slice(eq + 1)]);
      if (!spec.values.has(arg.slice(0, eq)) && !spec.switches.has(arg.slice(0, eq))) unsure = true;
    } else if (spec.values.has(arg) && i + 1 < args.length) {
      flags.push([arg, args[i + 1]]);
      i += 1;
    } else {
      flags.push([arg, true]);
      if (!spec.switches.has(arg)) unsure = true;
    }
  }
  const rest = args.slice(i);
  const tail = trailingSettings(spec, rest);
  return {
    command,
    flags,
    prompt: tail ? rest.slice(0, tail.at) : rest,
    dashed: false,
    unsure,
    tail: tail ? tail.flags : [],
  };
}

function looksLikeModel(value) {
  const text = String(value || '');
  if (/\d|\//.test(text)) return true;
  const { isClaudeFamilyModel } = require('./engine-registry');
  return isClaudeFamilyModel(text);
}

const EFFORT_VALUES = new Set([...EFFORT_WORDS, 'off', 'none', 'minimal']);

// The earliest point after the first prompt word from which every word is a
// known setting with its value, or null.
function trailingSettings(spec, words) {
  for (let at = 1; at < words.length; at += 1) {
    if (!words[at].startsWith('-')) continue;
    const flags = [];
    let k = at;
    for (; k < words.length; k += 1) {
      const word = words[k];
      const eq = word.startsWith('--') ? word.indexOf('=') : -1;
      if (eq > 0 && (spec.values.has(word.slice(0, eq)) || spec.switches.has(word.slice(0, eq)))) flags.push([word.slice(0, eq), word.slice(eq + 1)]);
      else if (spec.values.has(word) && k + 1 < words.length) { flags.push([word, words[k + 1]]); k += 1; }
      else if (spec.switches.has(word) && word !== '-p' && word !== '--print') flags.push([word, true]);
      else break;
    }
    if (k !== words.length) continue;
    const model = flagValue(flags, ['-m', '--model']);
    if (hasFlag(flags, ['-m', '--model']) && !looksLikeModel(model)) continue;
    const effort = flagValue(flags, ['--effort', '--reasoning-effort']);
    if (hasFlag(flags, ['--effort', '--reasoning-effort']) && !EFFORT_VALUES.has(effort)) continue;
    return { at, flags };
  }
  return null;
}

function hasFlag(flags, names) {
  return flags.some(([name]) => names.includes(name));
}

function flagValue(flags, names) {
  const found = flags.find(([name, value]) => names.includes(name) && typeof value === 'string');
  return found ? found[1] : '';
}

function effortOf(flags) {
  const direct = flagValue(flags, ['--effort', '--reasoning-effort', '--variant']);
  if (direct) return direct;
  for (const [name, value] of flags) {
    if (name !== '-c' && name !== '--config') continue;
    const match = /^model_reasoning_effort=["']?([a-z]+)/.exec(String(value));
    if (match) return match[1];
  }
  return '';
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

// An unsure reading: an unknown flag came before the prompt, so the words
// after it may be its value or the prompt. Read every flag-looking word
// before "--" as a setting just to decide whether this is a run, and take the
// prompt from after the -p when there is one.
function looseSplit(engine, args, split) {
  const dash = args.indexOf('--');
  const head = dash === -1 ? args : args.slice(0, dash);
  const flags = head.filter((word) => word.startsWith('-')).map((word) => [word, true]);
  const print = head.findIndex((word) => word === '-p' || word === '--print');
  const after = print === -1 ? null : splitArgs(engine, [...split.command, ...args.slice(print + 1)]);
  return { ...split, flags, prompt: after && after.prompt.length ? after.prompt : split.prompt };
}

// One ps line -> a run, or null when it is not an engine run at all.
function parseEngineProcess(entry) {
  if (!entry || !entry.command) return null;
  const tokens = entry.command.trim().split(/\s+/);
  let at = 0;
  if (INTERPRETERS.has(path.basename(tokens[0] || ''))) at = 1;
  // The orchestrator daemon is skipped by what it runs, never by what a
  // prompt mentions ("Review orchestrator.py" is real work).
  if (tokens.slice(0, at + 1).some((token) => /orchestrator/i.test(path.basename(token)))) return null;
  const binary = engineOf(tokens[at]);
  if (!binary) return null;
  const args = tokens.slice(at + 1);
  let split = splitArgs(binary, args);
  let verdict = RUN_RULES[binary](split);
  if (!verdict && split.unsure) {
    split = looseSplit(binary, args, split);
    verdict = RUN_RULES[binary](split);
  }
  if (!verdict) return null;
  const engine = typeof verdict === 'string' ? verdict : binary;
  const prompt = promptText(split);
  const memberMatch = MEMBER_PATTERN.exec(prompt.replace(/\\0?12/g, ' '));
  const member = memberMatch ? memberMatch[1].toLowerCase() : null;
  const settings = split.unsure ? [] : [...split.flags, ...split.tail];
  const model = flagValue(settings, ['-m', '--model']) || (split.unsure ? '' : axModel(binary, split.flags));
  return {
    pid: entry.pid,
    ppid: entry.ppid,
    engine,
    model: model || null,
    effort: effortOf(settings) || null,
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
