'use strict';

// atris engine codex --session <name> | --interactive | --computer-use
//
// Plain `atris engine codex "<question>"` stays what it was: a cold,
// read-only, isolated `codex exec` that ignores the owner's codex config.
// These flags take the warm path instead: a thread on the owner's shared
// Codex app-server daemon (lib/codex-daemon.js), which already runs with the
// owner's codex config, model, plugins, and MCP servers.
//
//   --session <name>  start or continue a named thread; names map to thread
//                     ids in .atris/state/codex-sessions.json
//   --interactive     read lines from stdin, one turn per line, same thread
//   --computer-use    keep the owner's codex sandbox so codex can act on the
//                     computer; model and effort come from the roster job
//                     "computer use"
//
// Without --computer-use a thread runs read-only: sandbox read-only,
// approvals never, and read-only developer instructions. A read-only session
// never turns into a computer-use one; that takes a new name. When the
// daemon cannot be reached, the turn runs as a one-shot `codex exec` after one
// plain line saying so.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const {
  connectCodexDaemon,
  resumeCodexThread,
  runCodexTurn,
  startCodexThread,
} = require('./codex-daemon');
const {
  MAX_ASK_TIMEOUT_MS,
  askEffortArgs,
  buildReadOnlyEngineInvocation,
  rosterJobPin,
  runAskProcess,
} = require('./engine-ask');
const { RUNNER_PROFILE_DEFS } = require('./runner-command');

const SESSIONS_SCHEMA = 'atris.codex_sessions.v1';
const DEFAULT_TURN_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_SESSION_PROMPT_BYTES = 256 * 1024;
const SESSION_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MODE_ASK = 'ask';
const MODE_COMPUTER_USE = 'computer-use';
const ASK_JOB = 'ask';
const COMPUTER_USE_JOB = 'computer use';
const READ_ONLY_SESSION_INSTRUCTIONS = [
  'This is a read-only session.',
  'Do not modify files, create worktrees, start background agents, or run commands or tools with side effects.',
].join(' ');

// True when the shorthand args ask for the daemon path instead of a plain ask.
function wantsCodexSession(args = []) {
  return args.some((arg) => {
    const value = String(arg || '');
    return value === '--interactive' || value === '--computer-use' || value === '--session' || value.startsWith('--session=');
  });
}

function sessionUsage() {
  return [
    'usage:',
    '  atris engine codex --session <name> "<prompt>"     start or continue a named codex thread',
    '  atris engine codex --session <name> --interactive  one turn per line on the same thread',
    '  atris engine codex --computer-use "<task>"         let codex act on this computer',
    '',
    'options:',
    '  --model <name>    model for the thread (default: the roster pick, else your codex config)',
    `  --timeout <sec>   limit per turn, 1-${MAX_ASK_TIMEOUT_MS / 1000} (default ${DEFAULT_TURN_TIMEOUT_MS / 1000})`,
    '',
    'these run on your shared codex app-server daemon, with your codex config, model, and plugins,',
    'so there is no cold start. a session is read-only unless it began with --computer-use, which',
    'keeps your codex sandbox and takes its model and effort from the roster job "computer use".',
    'plain atris engine codex "<question>" is still a one-shot read-only codex exec without your config.',
    'if the daemon is not reachable, the turn runs as a one-shot codex exec and says so.',
    'session names live in .atris/state/codex-sessions.json',
  ].join('\n');
}

function normalizeSessionName(raw) {
  const name = String(raw || '').trim().toLowerCase();
  if (!name) throw new Error('--session needs a name, for example --session review');
  if (!SESSION_NAME_PATTERN.test(name)) {
    throw new Error(`session names use letters, numbers, dots, dashes, or underscores, up to 64 characters; "${String(raw).trim().slice(0, 80)}" does not fit`);
  }
  return name;
}

function parseTimeoutSeconds(raw) {
  const value = Number(raw);
  const max = MAX_ASK_TIMEOUT_MS / 1000;
  if (!Number.isInteger(value) || value < 1 || value > max) throw new Error(`--timeout must be an integer from 1 to ${max}`);
  return value * 1000;
}

function parseCodexSessionArgs(args = []) {
  const parsed = {
    session: '',
    interactive: false,
    computerUse: false,
    model: '',
    timeoutMs: DEFAULT_TURN_TIMEOUT_MS,
    prompt: '',
    help: false,
  };
  let sessionFlag = false;
  const promptParts = [];
  const valueAfter = (flag, index) => {
    const value = args[index + 1];
    if (value === undefined || String(value).startsWith('--')) throw new Error(`${flag} needs a value`);
    return String(value);
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = String(args[index]);
    if (arg === '--help' || arg === '-h') { parsed.help = true; continue; }
    if (arg === '--interactive') { parsed.interactive = true; continue; }
    if (arg === '--computer-use') { parsed.computerUse = true; continue; }
    if (arg === '--session') { sessionFlag = true; parsed.session = valueAfter(arg, index); index += 1; continue; }
    if (arg.startsWith('--session=')) { sessionFlag = true; parsed.session = arg.slice('--session='.length); continue; }
    if (arg === '--model') { parsed.model = valueAfter(arg, index).trim(); index += 1; continue; }
    if (arg.startsWith('--model=')) { parsed.model = arg.slice('--model='.length).trim(); continue; }
    if (arg === '--timeout') { parsed.timeoutMs = parseTimeoutSeconds(valueAfter(arg, index)); index += 1; continue; }
    if (arg.startsWith('--timeout=')) { parsed.timeoutMs = parseTimeoutSeconds(arg.slice('--timeout='.length)); continue; }
    if (arg.startsWith('--')) throw new Error(`unknown option ${arg} (see atris engine codex --session x --help)`);
    promptParts.push(arg);
  }
  if (parsed.help) return parsed;
  if (sessionFlag) parsed.session = normalizeSessionName(parsed.session);
  parsed.prompt = promptParts.join(' ').trim();
  if (!parsed.prompt && !parsed.interactive) throw new Error('give a prompt, or add --interactive to type one turn per line');
  if (Buffer.byteLength(parsed.prompt) > MAX_SESSION_PROMPT_BYTES) {
    throw new Error(`the prompt must be ${MAX_SESSION_PROMPT_BYTES / 1024} KB or less`);
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Session names to thread ids, per workspace.

function codexSessionsFile(root) {
  return path.join(root, '.atris', 'state', 'codex-sessions.json');
}

function readCodexSessions(root) {
  try {
    const data = JSON.parse(fs.readFileSync(codexSessionsFile(root), 'utf8'));
    const sessions = data && data.sessions && typeof data.sessions === 'object' && !Array.isArray(data.sessions) ? data.sessions : {};
    return { schema: SESSIONS_SCHEMA, sessions };
  } catch {
    return { schema: SESSIONS_SCHEMA, sessions: {} };
  }
}

function savedCodexSession(root, name) {
  const { sessions } = readCodexSessions(root);
  if (!Object.prototype.hasOwnProperty.call(sessions, name)) return null;
  const record = sessions[name];
  return record && typeof record === 'object' && typeof record.thread_id === 'string' && record.thread_id ? record : null;
}

// Rereads right before writing, so a session saved by another shell in the
// meantime keeps its entry.
function saveCodexSession(root, name, record) {
  const file = codexSessionsFile(root);
  const store = readCodexSessions(root);
  store.sessions[name] = record;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`);
    fs.renameSync(tmp, file);
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
  return record;
}

// ---------------------------------------------------------------------------
// What each mode sends.

function codexThreadStartParams({ mode, cwd, model = '' }) {
  const params = { cwd, approvalPolicy: 'never' };
  if (model) params.model = model;
  if (mode !== MODE_COMPUTER_USE) {
    params.sandbox = 'read-only';
    params.developerInstructions = READ_ONLY_SESSION_INSTRUCTIONS;
  }
  return params;
}

// A reopened thread keeps its own instructions; the sandbox and approval
// settings ride along again so a read-only session stays read-only.
function codexThreadResumeParams({ mode, threadId, model = '' }) {
  const params = { threadId, approvalPolicy: 'never' };
  if (model) params.model = model;
  if (mode !== MODE_COMPUTER_USE) params.sandbox = 'read-only';
  return params;
}

// The one-shot fallback. A read-only turn is exactly the plain ask command.
// Computer use needs the owner's codex config (model, plugins, MCP servers,
// sandbox), so it drops --ignore-user-config, --ignore-rules, the read-only
// sandbox, and the read-only preamble.
function codexExecFallbackInvocation({ mode, prompt, model = '', effort = '', timeoutMs = DEFAULT_TURN_TIMEOUT_MS }) {
  if (mode !== MODE_COMPUTER_USE) return buildReadOnlyEngineInvocation('codex', prompt, model, { timeoutMs, effort });
  return {
    engine: 'codex',
    bin: RUNNER_PROFILE_DEFS.codex.bin,
    args: [
      'exec',
      ...(model ? ['-m', model] : []),
      ...askEffortArgs('codex', effort),
      '--ephemeral',
      '--skip-git-repo-check',
      '--color', 'never',
      String(prompt),
    ],
  };
}

function turnExitCode(status) {
  if (status === 'completed') return 0;
  if (status === 'interrupted') return 130;
  return 1;
}

function seconds(ms) {
  return `${(Math.max(0, Number(ms) || 0) / 1000).toFixed(1)}s`;
}

// ---------------------------------------------------------------------------
// The command.

async function runCodexSessionCommand(args, root = process.cwd(), deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const say = (line) => stderr.write(`${line}\n`);
  let parsed;
  try {
    parsed = parseCodexSessionArgs(args);
  } catch (error) {
    say(`engine codex: ${error.message}`);
    return 2;
  }
  if (parsed.help) {
    stdout.write(`${sessionUsage()}\n`);
    return 0;
  }

  const name = parsed.session;
  const saved = name ? savedCodexSession(root, name) : null;
  if (parsed.computerUse && saved && saved.mode !== MODE_COMPUTER_USE) {
    say(`engine codex: session ${name} is read-only; computer use needs a new session name`);
    return 2;
  }
  const mode = parsed.computerUse || (saved && saved.mode === MODE_COMPUTER_USE) ? MODE_COMPUTER_USE : MODE_ASK;
  const pin = (deps.rosterPin || rosterJobPin)(mode === MODE_COMPUTER_USE ? COMPUTER_USE_JOB : ASK_JOB, 'codex', root) || {};
  const model = parsed.model || pin.roster_model || '';
  const effort = pin.roster_effort || '';
  if (mode === MODE_COMPUTER_USE && !model) say('note: the roster job "computer use" pins no codex model, so codex uses its own default model');

  const context = {
    root, name, saved, mode, model, effort, parsed, stdout, stderr, say, deps,
    activeAbort: null,
    midLine: false,
    now: deps.now || (() => new Date()),
  };
  // Answers stream to stdout and notes go to stderr; a note never starts in
  // the middle of an answer line.
  context.write = (text) => {
    if (!text) return;
    stdout.write(text);
    context.midLine = !text.endsWith('\n');
  };
  context.endLine = () => {
    if (context.midLine) context.write('\n');
  };
  const signals = deps.signals === undefined ? process : deps.signals;
  const onSigint = () => {
    if (context.activeAbort && !context.activeAbort.signal.aborted) {
      context.endLine();
      say('stopping the turn (ctrl-c again to quit now)');
      context.activeAbort.abort();
      return;
    }
    if (context.closeInput) {
      context.closeInput();
      return;
    }
    (deps.exit || process.exit)(130);
  };
  if (signals) signals.on('SIGINT', onSigint);
  try {
    let client;
    try {
      client = await (deps.connect || connectCodexDaemon)({ cwd: root, env: deps.env || process.env });
    } catch (error) {
      return await runExecFallback(context, `codex daemon not reachable (${error.message})`);
    }
    try {
      return await runDaemonSession(context, client);
    } finally {
      await client.close();
    }
  } finally {
    if (signals) signals.removeListener('SIGINT', onSigint);
  }
}

async function openThread(context, client) {
  const { root, name, saved, mode, model, say } = context;
  if (saved) {
    try {
      const resumed = await resumeCodexThread(client, codexThreadResumeParams({ mode, threadId: saved.thread_id, model }));
      return { ...resumed, fresh: false, record: saved };
    } catch (error) {
      if (error.reason !== 'rpc_error') throw error;
      say(`session ${name}: thread ${saved.thread_id} could not be reopened (${error.message}), so it starts a new thread`);
    }
  }
  const started = await startCodexThread(client, codexThreadStartParams({ mode, cwd: root, model }));
  let record = null;
  if (name) {
    // A visible name in the codex app and in `codex queue --thread`; a
    // failure here costs nothing but the label.
    try { await client.request('thread/name/set', { threadId: started.thread_id, name: `atris ${name}` }); } catch {}
    const at = context.now().toISOString();
    record = saveCodexSession(root, name, {
      thread_id: started.thread_id,
      mode,
      model: started.model || model || '',
      cwd: root,
      created_at: at,
      updated_at: at,
      turns: 0,
    });
  }
  return { ...started, fresh: true, record };
}

async function runDaemonSession(context, client) {
  const { name, parsed, say, root } = context;
  let thread;
  try {
    thread = await openThread(context, client);
  } catch (error) {
    // The daemon answered and said no (a bad model name, say): exec would
    // fail the same way, so report it instead of falling back.
    if (error.reason === 'rpc_error' || error.reason === 'protocol_error') {
      say(`engine codex: ${error.message}`);
      return 1;
    }
    await client.close();
    return runExecFallback(context, `codex daemon could not open the thread (${error.message})`);
  }
  let record = thread.record;
  const label = [`thread ${thread.thread_id}`, name ? `session ${name}` : '', thread.model || ''].filter(Boolean).join(', ');

  const daemonTurn = async (prompt) => {
    const abort = new AbortController();
    context.activeAbort = abort;
    let result;
    try {
      result = await runCodexTurn(client, {
        threadId: thread.thread_id,
        prompt,
        effort: context.effort,
        timeoutMs: parsed.timeoutMs,
        signal: abort.signal,
        onText: (chunk) => context.write(chunk),
        onActivity: (line) => { context.endLine(); say(`  ${line}`); },
        onNotice: (line) => { context.endLine(); say(`codex: ${line}`); },
      });
    } catch (error) {
      say(`engine codex: ${error.message}`);
      return 1;
    } finally {
      context.activeAbort = null;
    }
    context.endLine();
    if (record && name) {
      record = saveCodexSession(root, name, { ...record, updated_at: context.now().toISOString(), turns: (Number(record.turns) || 0) + 1 });
    }
    // A stop the person asked for needs no second line; any other failure says why.
    if (result.status !== 'completed' && result.error && result.error !== 'stopped') say(`codex: ${result.error}`);
    if (!parsed.interactive) {
      say(`${label}, ${result.status === 'completed' ? seconds(result.duration_ms) : `${result.status} after ${seconds(result.duration_ms)}`}`);
    } else {
      say(result.status === 'completed' ? `(${seconds(result.duration_ms)})` : `(${result.status} after ${seconds(result.duration_ms)})`);
    }
    return turnExitCode(result.status);
  };

  if (!parsed.interactive) return daemonTurn(parsed.prompt);
  const code = await runInteractive(context, daemonTurn, {
    banner: `codex ${name ? `session ${name}` : 'thread'} on the daemon (${thread.fresh ? 'new' : 'continued'}, ${thread.model || 'codex default model'}); one message per line, /exit or ctrl-d to quit`,
    stillOpen: () => !client.closed,
    closedNote: () => `the codex daemon connection closed${name ? `; run the same command again to continue session ${name}` : ''}`,
  });
  say(label);
  return code;
}

async function runExecFallback(context, why) {
  const { name, parsed, say } = context;
  if (parsed.interactive) say(`${why}, so each line runs as a one-shot codex exec with no memory of earlier lines`);
  else say(`${why}, so this runs as a one-shot codex exec${name ? ` and is not saved to session ${name}` : ''}`);
  const execTurn = (prompt) => runExecTurn(context, prompt);
  if (!parsed.interactive) return execTurn(parsed.prompt);
  return runInteractive(context, execTurn, { banner: 'codex exec, one message per line; /exit or ctrl-d to quit' });
}

async function runExecTurn(context, prompt) {
  const { root, mode, model, effort, parsed, stderr, say, deps } = context;
  const invocation = codexExecFallbackInvocation({ mode, prompt, model, effort, timeoutMs: parsed.timeoutMs });
  const abort = new AbortController();
  context.activeAbort = abort;
  let result;
  try {
    result = await (deps.runExec || runAskProcess)(invocation, {
      cwd: invocation.cwd || root,
      timeoutMs: parsed.timeoutMs,
      signal: abort.signal,
      onOutputChunk: (chunk, stream) => {
        const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
        if (stream === 'stderr') stderr.write(text);
        else context.write(text);
      },
    });
  } finally {
    context.activeAbort = null;
  }
  context.endLine();
  if (result.ok) return 0;
  if (result.cancelled) return 130;
  say(`codex exec ${String(result.reason || 'failed').replace(/_/g, ' ')}`);
  return 1;
}

// One turn per line. A TTY gets a prompt and line history; a pipe is read
// to the end. Lines typed during a turn wait their turn.
async function runInteractive(context, runTurn, { banner = '', stillOpen = () => true, closedNote = () => '' } = {}) {
  const { parsed, say, deps } = context;
  const input = deps.stdin || process.stdin;
  const output = context.stdout;
  const tty = Boolean(input.isTTY && output.isTTY);
  const rl = readline.createInterface({ input, output: tty ? output : undefined, terminal: tty });
  let closed = false;
  rl.once('close', () => { closed = true; });
  context.closeInput = () => rl.close();
  rl.on('SIGINT', () => {
    if (context.activeAbort && !context.activeAbort.signal.aborted) {
      context.endLine();
      say('stopping the turn');
      context.activeAbort.abort();
    } else {
      rl.close();
    }
  });
  if (tty) {
    rl.setPrompt('codex> ');
    if (banner) say(banner);
  }
  const prompt = () => { if (tty && !closed) rl.prompt(); };
  let failed = 0;
  const take = async (text) => {
    const code = await runTurn(text);
    if (code !== 0 && code !== 130) failed += 1;
    if (!stillOpen()) {
      const note = closedNote();
      if (note) say(note);
      rl.close();
      return false;
    }
    return true;
  };
  try {
    if (parsed.prompt && !(await take(parsed.prompt))) return 1;
    prompt();
    for await (const raw of rl) {
      const line = String(raw).trim();
      if (line === '/exit' || line === '/quit') break;
      if (line && !(await take(line))) return 1;
      prompt();
    }
  } finally {
    context.closeInput = null;
    rl.close();
  }
  return failed ? 1 : 0;
}

module.exports = {
  DEFAULT_TURN_TIMEOUT_MS,
  MODE_ASK,
  MODE_COMPUTER_USE,
  READ_ONLY_SESSION_INSTRUCTIONS,
  codexExecFallbackInvocation,
  codexSessionsFile,
  codexThreadResumeParams,
  codexThreadStartParams,
  normalizeSessionName,
  parseCodexSessionArgs,
  readCodexSessions,
  runCodexSessionCommand,
  saveCodexSession,
  savedCodexSession,
  sessionUsage,
  wantsCodexSession,
};
