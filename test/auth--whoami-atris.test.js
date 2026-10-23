// whoamiAtris reads the login from a temp HOME only, so these runs never touch
// the real ~/.atris or the network. Every path tested here returns before any
// API call: a missing login, a scoped agent key with an expiry, and a key that
// already expired.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { whoamiAtris } = require('../commands/auth');
const { AGENT_TOKEN_EXPIRED_DETAIL } = require('../utils/auth');

// Stands in for process.exit so the test can stop where the CLI would exit.
class ExitSignal extends Error {
  constructor(code) {
    super(`exit ${code}`);
    this.code = code;
  }
}

const jwt = (claims) => `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;

function sandbox(t, credentials) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-whoami-'));
  const savedHome = process.env.HOME;
  const savedAtris = {};
  for (const name of Object.keys(process.env)) {
    if (name.startsWith('ATRIS_')) {
      savedAtris[name] = process.env[name];
      delete process.env[name];
    }
  }
  process.env.HOME = home;

  if (credentials) {
    fs.mkdirSync(path.join(home, '.atris'), { recursive: true });
    fs.writeFileSync(path.join(home, '.atris', 'credentials.json'), JSON.stringify(credentials));
  }

  t.after(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    for (const name of Object.keys(process.env)) {
      if (name.startsWith('ATRIS_')) delete process.env[name];
    }
    Object.assign(process.env, savedAtris);
    fs.rmSync(home, { recursive: true, force: true });
  });
}

// Runs whoamiAtris with the given CLI args and returns what it printed before
// the first process.exit call, plus that exit code.
async function runWhoami(args) {
  const savedArgv = process.argv;
  const savedExit = process.exit;
  const savedLog = console.log;
  const savedError = console.error;
  const stdout = [];
  const stderr = [];
  let exit = null;

  process.argv = ['node', 'atris', 'whoami', ...args];
  console.log = (...parts) => stdout.push(parts.join(' '));
  console.error = (...parts) => stderr.push(parts.join(' '));
  process.exit = (code = 0) => {
    if (!exit) exit = { code, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
    throw new ExitSignal(code);
  };

  try {
    await whoamiAtris();
  } catch (error) {
    if (!(error instanceof ExitSignal)) throw error;
  } finally {
    process.argv = savedArgv;
    process.exit = savedExit;
    console.log = savedLog;
    console.error = savedError;
  }

  assert.ok(exit, 'whoamiAtris never called process.exit');
  return exit;
}

test('whoami --json reports a valid scoped agent key without a network call', async (t) => {
  // exp is in 2100, so this stays valid for any clock a test run will see.
  const token = jwt({ type: 'agent_access', scopes: ['youtube'], exp: 4102444800 });
  sandbox(t, {
    token,
    email: 'tester@example.com',
    user_id: 'user_123',
    provider: 'github',
    saved_at: '2026-01-02T03:04:05.000Z',
  });

  const result = await runWhoami(['--json']);

  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout), {
    ok: true,
    logged_in: true,
    email: 'tester@example.com',
    user_id: 'user_123',
    provider: 'github',
    credentials_saved: '2026-01-02T03:04:05.000Z',
  });
});

test('whoami --json with no login prints not_logged_in and exits 1', async (t) => {
  sandbox(t);

  const result = await runWhoami(['--json']);

  assert.equal(result.code, 1);
  assert.deepEqual(JSON.parse(result.stdout), {
    ok: false,
    logged_in: false,
    error: 'not_logged_in',
    detail: null,
  });
});

test('whoami with no login prints a sign-in hint and exits 1', async (t) => {
  sandbox(t);

  const result = await runWhoami([]);

  assert.equal(result.code, 1);
  assert.match(result.stdout, /^Status: Not logged in$/m);
  assert.match(result.stdout, /Run "atris login" to sign in\./);
});

test('whoami --json with an expired agent key reports token_invalid and exits 1', async (t) => {
  // exp of 1 is 1970, so the key is expired on every clock.
  const token = jwt({ type: 'agent_access', scopes: ['youtube'], exp: 1 });
  sandbox(t, { token, email: 'tester@example.com' });

  const result = await runWhoami(['--json']);

  assert.equal(result.code, 1);
  assert.deepEqual(JSON.parse(result.stdout), {
    ok: false,
    logged_in: false,
    error: 'token_invalid',
    detail: AGENT_TOKEN_EXPIRED_DETAIL,
  });
});
