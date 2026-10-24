const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Keep the machine out of it. serveAtris reads its settings through the
// helpers stubbed below, so the cleared env and fake HOME are a guard only.
for (const key of Object.keys(process.env)) {
  if (key.startsWith('ATRIS_')) delete process.env[key];
}
const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-serve-atris-'));
process.env.HOME = path.join(workRoot, 'home');
after(() => fs.rmSync(workRoot, { recursive: true, force: true }));

// serve.js destructures these helpers when it loads, so swap them out first.
// Nothing here touches the network, a real credentials file, or a real session.
const auth = require('../utils/auth');
const api = require('../utils/api');

const fake = {
  credentials: null,
  registerResult: null,
  apiCalls: [],
  streamStarts: 0,
};

auth.loadCredentials = () => fake.credentials;

api.apiRequestJson = async (pathname, options = {}) => {
  fake.apiCalls.push({ pathname, method: options.method, token: options.token, body: options.body });
  if (options.method === 'POST' && pathname === '/cli/sessions') return fake.registerResult;
  if (options.method === 'DELETE') return { ok: true, status: 200, data: {} };
  throw new Error(`unexpected api call: ${options.method} ${pathname}`);
};

// The event stream is the endless part of serveAtris. Reaching it means the
// bridge is up. Fire SIGINT so shutdown() sets its flag, then fail the stream.
// The reconnect loop sees the flag and returns instead of retrying.
api.getApiBaseUrl = () => {
  fake.streamStarts += 1;
  process.emit('SIGINT');
  throw new Error('stream stubbed out');
};

const { serveAtris } = require('../commands/serve');

const SIGNALS = ['SIGINT', 'SIGTERM'];

class ExitSignal extends Error {
  constructor(code) {
    super(`process.exit(${code})`);
    this.code = code;
  }
}

// Runs serveAtris once in a fresh directory with console and process.exit captured.
// exitThrows stands in for a process that stops at exit. Real exit never returns,
// so code after it must not run. Set it false when exit is called from shutdown().
async function runServe(options, scenario) {
  const { credentials = null, registerResult = null, exitThrows = true } = scenario;
  const dir = fs.mkdtempSync(path.join(workRoot, 'run-'));
  const savedCwd = process.cwd();
  const savedListeners = new Map(SIGNALS.map((s) => [s, process.listeners(s)]));
  const realLog = console.log;
  const realError = console.error;
  const realExit = process.exit;
  const logs = [];
  const errors = [];
  const exits = [];

  fake.credentials = credentials;
  fake.registerResult = registerResult;
  fake.apiCalls = [];
  fake.streamStarts = 0;

  console.log = (...args) => logs.push(args.join(' '));
  console.error = (...args) => errors.push(args.join(' '));
  process.exit = (code) => {
    exits.push(code);
    if (exitThrows) throw new ExitSignal(code);
  };
  process.chdir(dir);

  try {
    let rejected = null;
    try {
      await serveAtris(options);
    } catch (err) {
      rejected = err;
    }
    // shutdown() finishes after serveAtris returns, so let its last steps run.
    await new Promise((resolve) => setImmediate(resolve));
    return {
      rejected,
      logs,
      errors,
      exits,
      apiCalls: fake.apiCalls,
      streamStarts: fake.streamStarts,
      dir: fs.realpathSync(dir),
    };
  } finally {
    process.chdir(savedCwd);
    console.log = realLog;
    console.error = realError;
    process.exit = realExit;
    for (const s of SIGNALS) {
      for (const listener of process.listeners(s)) {
        if (!savedListeners.get(s).includes(listener)) process.removeListener(s, listener);
      }
    }
  }
}

test('not logged in: exits 1 before any banner or API call', async () => {
  const run = await runServe({}, { credentials: null });

  assert.ok(run.rejected instanceof ExitSignal);
  assert.equal(run.rejected.code, 1);
  assert.deepEqual(run.errors, ['Not logged in. Run: atris login']);
  assert.deepEqual(run.logs, []);
  assert.deepEqual(run.apiCalls, []);
  assert.equal(run.streamStarts, 0);
});

test('backend rejects registration: exits 1 and never opens the stream', async () => {
  const run = await runServe({}, {
    credentials: { token: 'tok_test' },
    registerResult: { ok: false, status: 500, errorMessage: 'backend down' },
  });

  assert.ok(run.rejected instanceof ExitSignal);
  assert.equal(run.exits[0], 1);
  // The exit stub throws, so the catch below also runs and logs a second line.
  // Only the first line is the real one.
  assert.equal(run.errors[0], '✗ Failed to create session: backend down');
  assert.equal(run.apiCalls.length, 1);
  assert.equal(run.streamStarts, 0);
});

test('agent and bash options: registers with them, then deletes the session on shutdown', async () => {
  const run = await runServe({ agent: 'agent_42', allowBash: true }, {
    credentials: { token: 'tok_test' },
    registerResult: { ok: true, status: 200, data: { session_id: 'sess_42' } },
    exitThrows: false,
  });

  assert.equal(run.rejected, null);
  assert.deepEqual(run.apiCalls, [
    {
      pathname: '/cli/sessions',
      method: 'POST',
      token: 'tok_test',
      body: { working_directory: run.dir, agent_id: 'agent_42', allow_bash: true },
    },
    {
      pathname: '/cli/sessions/sess_42',
      method: 'DELETE',
      token: 'tok_test',
      body: undefined,
    },
  ]);
  assert.ok(run.logs.includes('  ✓ Session: sess_42'));
  assert.match(run.logs.join('\n'), /Bash:\s+enabled \(REMOTE BASH ALLOWED\)/);
  assert.equal(run.streamStarts, 1);
  assert.deepEqual(run.errors, []);
  assert.deepEqual(run.exits, [0]);
});

test('empty options: no agent and bash stays off', async () => {
  const run = await runServe({}, {
    credentials: { token: 'tok_test' },
    registerResult: { ok: true, status: 200, data: { session_id: 'sess_0' } },
    exitThrows: false,
  });

  assert.deepEqual(run.apiCalls[0].body, {
    working_directory: run.dir,
    agent_id: null,
    allow_bash: false,
  });
  const banner = run.logs.join('\n');
  assert.match(banner, /Agent:\s+\(none\)/);
  assert.match(banner, /Bash:\s+disabled \(read\/write\/edit\/delete only\)/);
  assert.deepEqual(run.exits, [0]);
});

test('allowBash only turns on for a literal true, not a truthy string', async () => {
  const run = await runServe({ allowBash: 'yes' }, {
    credentials: { token: 'tok_test' },
    registerResult: { ok: true, status: 200, data: { session_id: 'sess_1' } },
    exitThrows: false,
  });

  assert.equal(run.apiCalls[0].body.allow_bash, false);
  assert.match(run.logs.join('\n'), /Bash:\s+disabled/);
});
