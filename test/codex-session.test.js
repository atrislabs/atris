'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');

const { connectCodexDaemon } = require('../lib/codex-daemon');
const {
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
  wantsCodexSession,
} = require('../lib/codex-session');
const { buildReadOnlyEngineInvocation } = require('../lib/engine-ask');
const { engineCommand } = require('../commands/engine');

const FAKE_PROXY = path.join(__dirname, 'helpers', 'fake-codex-proxy.js');
const CHILD_BOOT_MS = 15000;

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-codex-session-'));
}

function sink() {
  const chunks = [];
  return { isTTY: false, write: (chunk) => { chunks.push(String(chunk)); return true; }, text: () => chunks.join('') };
}

function readLog(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function received(file, method) {
  return readLog(file).filter((entry) => entry.dir === 'in' && entry.message.method === method).map((entry) => entry.message.params);
}

// Command deps that reach the fake proxy through the real client.
function fakeDeps(root, script = {}, extra = {}) {
  const logFile = path.join(root, 'fake.jsonl');
  const stdout = sink();
  const stderr = sink();
  const connects = [];
  const deps = {
    stdout,
    stderr,
    signals: null,
    rosterPin: () => ({}),
    now: () => new Date('2026-10-29T12:00:00.000Z'),
    connect: (options) => {
      connects.push(options);
      return connectCodexDaemon({
        ...options,
        bin: process.execPath,
        args: [FAKE_PROXY, '--serve'],
        env: { ...process.env, FAKE_CODEX_LOG: logFile, FAKE_CODEX_SCRIPT: JSON.stringify(script) },
        connectTimeoutMs: CHILD_BOOT_MS,
      });
    },
    runExec: async () => { throw new Error('exec must not run while the daemon answers'); },
    ...extra,
  };
  return { deps, logFile, stdout, stderr, connects };
}

test('session flags are spotted and parsed; names are checked', () => {
  assert.equal(wantsCodexSession(['--session', 'x', 'hi']), true);
  assert.equal(wantsCodexSession(['--session=x', 'hi']), true);
  assert.equal(wantsCodexSession(['--interactive']), true);
  assert.equal(wantsCodexSession(['--computer-use', 'open notes']), true);
  assert.equal(wantsCodexSession(['--model', 'gpt-6', 'hi']), false);

  const parsed = parseCodexSessionArgs(['--session', 'Review-1', '--model', 'gpt-6.1-terra', '--timeout', '90', 'look', 'at this']);
  assert.equal(parsed.session, 'review-1');
  assert.equal(parsed.model, 'gpt-6.1-terra');
  assert.equal(parsed.timeoutMs, 90000);
  assert.equal(parsed.prompt, 'look at this');
  assert.equal(parseCodexSessionArgs(['--session=a.b_c', 'x']).session, 'a.b_c');
  assert.equal(parseCodexSessionArgs(['--interactive']).prompt, '');
  assert.equal(parseCodexSessionArgs(['--computer-use', 'x']).computerUse, true);

  assert.throws(() => parseCodexSessionArgs(['--session', 'x']), /give a prompt, or add --interactive/);
  assert.throws(() => parseCodexSessionArgs(['--session']), /--session needs a value/);
  assert.throws(() => parseCodexSessionArgs(['--session=', 'x']), /--session needs a name/);
  assert.throws(() => parseCodexSessionArgs(['--session', 'x', '--timeout', '0', 'hi']), /--timeout must be an integer/);
  assert.throws(() => parseCodexSessionArgs(['--session', 'x', '--yolo', 'hi']), /unknown option --yolo/);
  assert.throws(() => normalizeSessionName('../etc'), /does not fit/);
  assert.throws(() => normalizeSessionName('__proto__'), /does not fit/);
  assert.throws(() => normalizeSessionName('x'.repeat(65)), /does not fit/);
  assert.equal(normalizeSessionName(' Fix-12 '), 'fix-12');
});

test('session names map to thread ids in .atris/state, and a bad file reads as empty', () => {
  const root = tempRoot();
  try {
    assert.deepEqual(readCodexSessions(root).sessions, {});
    saveCodexSession(root, 'review', { thread_id: 't-1', mode: MODE_ASK });
    saveCodexSession(root, 'browse', { thread_id: 't-2', mode: MODE_COMPUTER_USE });
    assert.equal(codexSessionsFile(root), path.join(root, '.atris', 'state', 'codex-sessions.json'));
    assert.equal(savedCodexSession(root, 'review').thread_id, 't-1');
    assert.equal(savedCodexSession(root, 'browse').mode, MODE_COMPUTER_USE);
    // A name that is also an Object.prototype key is just an unsaved session.
    assert.equal(savedCodexSession(root, 'constructor'), null);
    assert.equal(savedCodexSession(root, 'missing'), null);
    fs.writeFileSync(codexSessionsFile(root), '{not json');
    assert.equal(savedCodexSession(root, 'review'), null);
    assert.deepEqual(fs.readdirSync(path.dirname(codexSessionsFile(root))), ['codex-sessions.json'], 'no temp files left behind');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('read-only sessions pin the sandbox; computer use keeps the owner config', () => {
  assert.deepEqual(codexThreadStartParams({ mode: MODE_ASK, cwd: '/w', model: 'gpt-6.1-terra' }), {
    cwd: '/w',
    approvalPolicy: 'never',
    model: 'gpt-6.1-terra',
    sandbox: 'read-only',
    developerInstructions: READ_ONLY_SESSION_INSTRUCTIONS,
  });
  const computer = codexThreadStartParams({ mode: MODE_COMPUTER_USE, cwd: '/w' });
  assert.deepEqual(computer, { cwd: '/w', approvalPolicy: 'never' }, 'no sandbox override and no model: the owner config decides both');
  assert.deepEqual(codexThreadResumeParams({ mode: MODE_ASK, threadId: 't' }), { threadId: 't', approvalPolicy: 'never', sandbox: 'read-only' });
  assert.deepEqual(codexThreadResumeParams({ mode: MODE_COMPUTER_USE, threadId: 't', model: 'm' }), { threadId: 't', approvalPolicy: 'never', model: 'm' });
});

test('exec fallback: a read-only turn is the plain ask; computer use keeps user config', () => {
  const ask = codexExecFallbackInvocation({ mode: MODE_ASK, prompt: 'why', model: 'gpt-6.1-terra' });
  assert.deepEqual(ask, buildReadOnlyEngineInvocation('codex', 'why', 'gpt-6.1-terra'));
  for (const flag of ['--ignore-user-config', '--ignore-rules', '--ephemeral']) assert.ok(ask.args.includes(flag), flag);
  assert.deepEqual(ask.args.slice(ask.args.indexOf('--sandbox'), ask.args.indexOf('--sandbox') + 2), ['--sandbox', 'read-only']);

  const computer = codexExecFallbackInvocation({ mode: MODE_COMPUTER_USE, prompt: 'open notes', model: 'gpt-6.1-terra', effort: 'medium' });
  assert.equal(computer.bin, 'codex');
  assert.deepEqual(computer.args, ['exec', '-m', 'gpt-6.1-terra', '-c', 'model_reasoning_effort=medium', '--ephemeral', '--skip-git-repo-check', '--color', 'never', 'open notes']);
  for (const flag of ['--ignore-user-config', '--ignore-rules', '--sandbox']) assert.ok(!computer.args.includes(flag), `${flag} would drop the owner config or sandbox`);
  assert.doesNotMatch(computer.args.join(' '), /read-only request/);
});

test('a new session streams the answer, names the thread, and saves its id', async () => {
  const root = tempRoot();
  const { deps, logFile, stdout, stderr } = fakeDeps(root, { reply: ['O', 'K'] });
  try {
    const code = await runCodexSessionCommand(['--session', 'Review', 'reply', 'with OK'], root, deps);
    assert.equal(code, 0, stderr.text());
    assert.equal(stdout.text(), 'OK\n');
    assert.match(stderr.text(), /thread thread-new-1, session review, gpt-fake, \d+\.\ds/);
    assert.match(stderr.text(), /ran: ls -la/);

    const [start] = received(logFile, 'thread/start');
    assert.equal(start.cwd, root);
    assert.equal(start.sandbox, 'read-only');
    assert.equal(start.approvalPolicy, 'never');
    assert.equal(start.model, undefined, 'no roster pin and no --model: the owner codex config picks the model');
    assert.deepEqual(received(logFile, 'thread/name/set'), [{ threadId: 'thread-new-1', name: 'atris review' }]);
    assert.deepEqual(received(logFile, 'turn/start')[0].input, [{ type: 'text', text: 'reply with OK' }]);

    const saved = savedCodexSession(root, 'review');
    assert.equal(saved.thread_id, 'thread-new-1');
    assert.equal(saved.mode, MODE_ASK);
    assert.equal(saved.cwd, root);
    assert.equal(saved.turns, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a saved session continues its thread with resume, not a new start', async () => {
  const root = tempRoot();
  saveCodexSession(root, 'review', { thread_id: 'thread-old-7', mode: MODE_ASK, turns: 3 });
  const { deps, logFile, stdout } = fakeDeps(root, { reply: ['again'] });
  try {
    const code = await runCodexSessionCommand(['--session', 'review', 'and now?'], root, deps);
    assert.equal(code, 0);
    assert.equal(stdout.text(), 'again\n');
    assert.deepEqual(received(logFile, 'thread/resume'), [{ excludeTurns: true, threadId: 'thread-old-7', approvalPolicy: 'never', sandbox: 'read-only' }]);
    assert.deepEqual(received(logFile, 'thread/start'), []);
    assert.equal(received(logFile, 'turn/start')[0].threadId, 'thread-old-7');
    assert.equal(savedCodexSession(root, 'review').turns, 4);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a thread the daemon no longer has gets replaced and the session follows it', async () => {
  const root = tempRoot();
  saveCodexSession(root, 'review', { thread_id: 'thread-gone', mode: MODE_ASK, turns: 2 });
  const { deps, logFile, stderr } = fakeDeps(root, { resumeError: 'no rollout found for thread id thread-gone' });
  try {
    const code = await runCodexSessionCommand(['--session', 'review', 'hi'], root, deps);
    assert.equal(code, 0);
    assert.match(stderr.text(), /session review: thread thread-gone could not be reopened .*no rollout found.*so it starts a new thread/);
    assert.equal(received(logFile, 'thread/start').length, 1);
    assert.equal(savedCodexSession(root, 'review').thread_id, 'thread-new-1');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('computer use takes model and effort from its roster job and keeps the owner sandbox', async () => {
  const root = tempRoot();
  const asked = [];
  const { deps, logFile } = fakeDeps(root, {}, {
    rosterPin: (job, engine) => {
      asked.push([job, engine]);
      return job === 'computer use' ? { roster_model: 'gpt-6.1-terra', roster_effort: 'medium' } : {};
    },
  });
  try {
    const code = await runCodexSessionCommand(['--computer-use', '--session', 'browse', 'open the notes app'], root, deps);
    assert.equal(code, 0);
    assert.deepEqual(asked, [['computer use', 'codex']]);
    const [start] = received(logFile, 'thread/start');
    assert.equal(start.model, 'gpt-6.1-terra');
    assert.equal(start.sandbox, undefined);
    assert.equal(start.developerInstructions, undefined);
    assert.equal(received(logFile, 'turn/start')[0].effort, 'medium');
    assert.equal(savedCodexSession(root, 'browse').mode, MODE_COMPUTER_USE);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a read-only session never turns into computer use, and nothing connects', async () => {
  const root = tempRoot();
  saveCodexSession(root, 'review', { thread_id: 'thread-old-7', mode: MODE_ASK });
  const { deps, stderr, connects } = fakeDeps(root);
  try {
    const code = await runCodexSessionCommand(['--session', 'review', '--computer-use', 'click it'], root, deps);
    assert.equal(code, 2);
    assert.match(stderr.text(), /session review is read-only; computer use needs a new session name/);
    assert.equal(connects.length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('no daemon: one plain line, then the plain codex exec ask runs', async () => {
  const root = tempRoot();
  const runs = [];
  const { deps, stdout, stderr } = fakeDeps(root, { exitImmediately: true }, {
    runExec: async (invocation, options) => {
      runs.push({ invocation, options });
      options.onOutputChunk(Buffer.from('exec says OK'), 'stdout');
      return { ok: true, reason: 'ok', cancelled: false };
    },
  });
  try {
    const code = await runCodexSessionCommand(['--session', 'review', 'reply OK'], root, deps);
    assert.equal(code, 0);
    const lines = stderr.text().trim().split('\n');
    assert.equal(lines.length, 1, stderr.text());
    assert.match(lines[0], /^codex daemon not reachable \(.*failed to connect to socket.*\), so this runs as a one-shot codex exec and is not saved to session review$/);
    assert.equal(stdout.text(), 'exec says OK\n');
    assert.equal(runs.length, 1);
    assert.deepEqual(runs[0].invocation, buildReadOnlyEngineInvocation('codex', 'reply OK', '', { timeoutMs: runs[0].options.timeoutMs }));
    assert.equal(runs[0].options.cwd, root);
    assert.equal(savedCodexSession(root, 'review'), null, 'a fallback turn is not saved to the session');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('no daemon in computer use: the exec fallback keeps the owner codex config', async () => {
  const root = tempRoot();
  const runs = [];
  const { deps } = fakeDeps(root, { exitImmediately: true }, {
    rosterPin: () => ({ roster_model: 'gpt-6.1-terra', roster_effort: 'medium' }),
    runExec: async (invocation) => {
      runs.push(invocation);
      return { ok: false, reason: 'exit_1', cancelled: false };
    },
  });
  try {
    const code = await runCodexSessionCommand(['--computer-use', 'open notes'], root, deps);
    assert.equal(code, 1);
    assert.ok(!runs[0].args.includes('--ignore-user-config'));
    assert.deepEqual(runs[0].args.slice(0, 5), ['exec', '-m', 'gpt-6.1-terra', '-c', 'model_reasoning_effort=medium']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('interactive: one turn per line on one thread, /exit stops reading', async () => {
  const root = tempRoot();
  const { deps, logFile, stdout } = fakeDeps(root, { reply: ['ok'] }, {
    stdin: Readable.from(['first question\n', '\n', 'second question\n', '/exit\n', 'never sent\n']),
  });
  try {
    const code = await runCodexSessionCommand(['--session', 'chat', '--interactive'], root, deps);
    assert.equal(code, 0);
    const turns = received(logFile, 'turn/start');
    assert.deepEqual(turns.map((params) => params.input[0].text), ['first question', 'second question']);
    assert.ok(turns.every((params) => params.threadId === 'thread-new-1'));
    assert.equal(received(logFile, 'thread/start').length, 1, 'one thread for the whole conversation');
    assert.equal(stdout.text(), 'ok\nok\n');
    assert.equal(savedCodexSession(root, 'chat').turns, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ctrl-c during a turn interrupts it on the daemon and exits 130', async () => {
  const root = tempRoot();
  const signals = new EventEmitter();
  const { deps, logFile, stderr } = fakeDeps(root, { hangTurn: true }, { signals });
  try {
    const pending = runCodexSessionCommand(['--session', 'slow', 'think hard'], root, deps);
    const deadline = Date.now() + CHILD_BOOT_MS;
    while (!received(logFile, 'turn/start').length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    signals.emit('SIGINT');
    assert.equal(await pending, 130);
    assert.deepEqual(received(logFile, 'turn/interrupt'), [{ threadId: 'thread-new-1', turnId: 'turn-1' }]);
    assert.match(stderr.text(), /stopping the turn/);
    assert.equal(signals.listenerCount('SIGINT'), 0, 'the handler is removed when the command ends');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('engine codex routes session flags to the daemon path, even with a task-like name', async () => {
  const root = tempRoot();
  const { deps, logFile } = fakeDeps(root);
  let dispatched = false;
  try {
    const code = await engineCommand(['codex', '--session', 'fix-1', 'hello'], {
      root,
      codexSession: deps,
      engineDispatch: () => { dispatched = true; return 0; },
    });
    assert.equal(code, 0);
    assert.equal(dispatched, false, '"fix-1" is a session name here, not a task id');
    assert.equal(received(logFile, 'turn/start').length, 1);

    const errors = [];
    const originalError = console.error;
    console.error = (line = '') => errors.push(String(line));
    try {
      assert.equal(await engineCommand(['claude', '--session', 'x', 'hi'], { root }), 2);
    } finally {
      console.error = originalError;
    }
    assert.match(errors.join('\n'), /--session, --interactive, and --computer-use work with codex only/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('engine ask points session flags at engine codex instead of a bare unknown option', async () => {
  const errors = [];
  const originalError = console.error;
  console.error = (line = '') => errors.push(String(line));
  try {
    const code = await engineCommand(['ask', 'hi', '--engine', 'codex', '--session', 'x']);
    assert.equal(code, 2);
  } finally {
    console.error = originalError;
  }
  assert.match(errors.join('\n'), /--session is not an ask option; it goes with atris engine codex/);
});
