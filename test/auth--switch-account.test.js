'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { switchAccount } = require('../commands/auth');

// Everything switchAccount reads from the environment, cleared for each test.
// TERM_SESSION_ID is then set to a fixed value so the code never shells out to
// `tty` to find a terminal id.
const ENV_KEYS = [
  'HOME',
  'USERPROFILE',
  'ATRIS_TOKEN',
  'ATRIS_PROFILE',
  'ATRIS_CLIENT_ID',
  'ATRIS_CLIENT_SECRET',
  'ATRIS_CLIENT_SECRET_FILE',
  'ATRIS_AGENT_TOKEN_FILE',
  'ATRIS_TEST_STATE_DIR',
  'ATRIS_TEST_PROTECTED_HOME',
  'ATRIS_TEST_REAL_HOME',
  'TERM_SESSION_ID',
  'ITERM_SESSION_ID',
  'TMUX_PANE',
  'WT_SESSION',
  'WEZTERM_PANE',
];
const TERMINAL_ID = 'atris-test-term';

class ExitSignal extends Error {
  constructor(code) {
    super(`process.exit(${code})`);
    this.code = code;
  }
}

async function withSandbox(fn) {
  const saved = {};
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-switch-account-'));
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.TERM_SESSION_ID = TERMINAL_ID;
  try {
    await fn(home);
  } finally {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
}

// Calls switchAccount as `atris switch <args>` would. process.exit becomes a
// thrown signal and console output is captured, all restored afterwards.
async function runSwitch(args) {
  const real = {
    argv: process.argv,
    exit: process.exit,
    log: console.log,
    error: console.error,
  };
  const out = [];
  const err = [];
  let exitCode = null;
  process.argv = ['node', 'atris', 'switch', ...args];
  process.exit = (code) => { throw new ExitSignal(code); };
  console.log = (...parts) => { out.push(parts.join(' ')); };
  console.error = (...parts) => { err.push(parts.join(' ')); };
  try {
    await switchAccount();
  } catch (error) {
    if (!(error instanceof ExitSignal)) throw error;
    exitCode = error.code;
  } finally {
    process.argv = real.argv;
    process.exit = real.exit;
    console.log = real.log;
    console.error = real.error;
  }
  return { exitCode, out, err };
}

function atrisPath(home, ...parts) {
  return path.join(home, '.atris', ...parts);
}

function writeProfile(home, name, data) {
  const dir = atrisPath(home, 'profiles');
  fs.mkdirSync(dir, { recursive: true });
  const body = typeof data === 'string' ? data : JSON.stringify(data);
  fs.writeFileSync(path.join(dir, `${name}.json`), body);
}

function writeGlobalCredentials(home, data) {
  fs.mkdirSync(atrisPath(home), { recursive: true });
  fs.writeFileSync(atrisPath(home, 'credentials.json'), JSON.stringify(data));
}

function readGlobalCredentials(home) {
  return JSON.parse(fs.readFileSync(atrisPath(home, 'credentials.json'), 'utf8'));
}

function human(name, extra = {}) {
  return {
    token: `token-${name}`,
    email: `${name}@example.com`,
    user_id: `user-${name}`,
    provider: 'manual',
    ...extra,
  };
}

test('switchAccount exits 1 with a hint when no accounts are saved', async () => {
  await withSandbox(async (home) => {
    const bare = await runSwitch([]);
    assert.strictEqual(bare.exitCode, 1);
    assert.deepStrictEqual(bare.out, ['No saved accounts. Run "atris login" to add one.']);
    assert.deepStrictEqual(bare.err, []);

    const named = await runSwitch(['alice', '--global']);
    assert.strictEqual(named.exitCode, 1);
    assert.deepStrictEqual(named.out, ['No saved accounts. Run "atris login" to add one.']);

    assert.strictEqual(fs.existsSync(atrisPath(home, 'credentials.json')), false);
  });
});

test('switchAccount --global copies the chosen profile into credentials.json', async () => {
  await withSandbox(async (home) => {
    const alice = human('alice');
    writeProfile(home, 'alice', alice);
    writeProfile(home, 'bob', human('bob'));
    writeGlobalCredentials(home, human('bob'));

    const result = await runSwitch(['alice', '--global']);

    assert.strictEqual(result.exitCode, null);
    assert.deepStrictEqual(result.err, []);
    assert.deepStrictEqual(result.out, ['Switched to alice@example.com (global, all terminals)']);
    assert.deepStrictEqual(readGlobalCredentials(home), alice);
    if (process.platform !== 'win32') {
      const mode = fs.statSync(atrisPath(home, 'credentials.json')).mode & 0o777;
      assert.strictEqual(mode, 0o600);
    }
  });
});

test('switchAccount matches exact name, then prefix, then substring, then email', async () => {
  await withSandbox(async (home) => {
    writeProfile(home, 'bob', human('bob', { email: 'bob@home.example' }));
    writeProfile(home, 'bobby', human('bobby', { email: 'bobby@home.example' }));
    writeProfile(home, 'xalice', human('xalice', { email: 'x@home.example' }));
    writeProfile(home, 'alice2', human('alice2', { email: 'a2@home.example' }));
    writeProfile(home, 'work', human('work', { email: 'dana@corp.example' }));

    const cases = [
      // exact name beats the longer name that also starts with it
      ['bob', 'bob@home.example'],
      // matching ignores case
      ['BOB', 'bob@home.example'],
      // prefix of exactly one name
      ['bobb', 'bobby@home.example'],
      // prefix match wins over a name that only contains the query
      ['alice', 'a2@home.example'],
      // substring of exactly one name
      ['ice2', 'a2@home.example'],
      // no name matches, so the saved email is searched
      ['corp.example', 'dana@corp.example'],
      ['DANA@CORP', 'dana@corp.example'],
    ];

    for (const [query, expectedEmail] of cases) {
      fs.rmSync(atrisPath(home, 'credentials.json'), { force: true });
      const result = await runSwitch([query, '--global']);
      assert.strictEqual(result.exitCode, null, `query ${query}`);
      assert.deepStrictEqual(
        result.out,
        [`Switched to ${expectedEmail} (global, all terminals)`],
        `query ${query}`,
      );
      assert.strictEqual(readGlobalCredentials(home).email, expectedEmail, `query ${query}`);
    }
  });
});

test('switchAccount reports unknown names and lists what is available', async () => {
  await withSandbox(async (home) => {
    writeProfile(home, 'alice', human('alice'));
    writeProfile(home, 'bob', human('bob'));

    const result = await runSwitch(['zed', '--global']);

    assert.strictEqual(result.exitCode, 1);
    assert.deepStrictEqual(result.err, ['No account matching "zed".']);
    assert.strictEqual(result.out.length, 1);
    assert.ok(result.out[0].startsWith('Available: '));
    assert.deepStrictEqual(result.out[0].slice('Available: '.length).split(', ').sort(), ['alice', 'bob']);
    assert.strictEqual(fs.existsSync(atrisPath(home, 'credentials.json')), false);
  });
});

test('switchAccount leaves credentials alone when the account is already active', async () => {
  await withSandbox(async (home) => {
    writeProfile(home, 'alice', human('alice', { token: 'token-in-profile' }));
    writeProfile(home, 'bob', human('bob'));
    writeGlobalCredentials(home, human('alice', { token: 'token-in-global-file' }));
    const before = fs.readFileSync(atrisPath(home, 'credentials.json'), 'utf8');

    const result = await runSwitch(['ALICE', '--global']);

    assert.strictEqual(result.exitCode, 0);
    assert.deepStrictEqual(result.out, ['Already on "alice".']);
    assert.deepStrictEqual(result.err, []);
    assert.strictEqual(fs.readFileSync(atrisPath(home, 'credentials.json'), 'utf8'), before);
  });
});

test('switchAccount refuses a profile with no token or with unreadable JSON', async () => {
  await withSandbox(async (home) => {
    writeProfile(home, 'broken', { email: 'broken@example.com' });
    writeProfile(home, 'garbled', '{ not json');

    for (const name of ['broken', 'garbled']) {
      const result = await runSwitch([name, '--global']);
      assert.strictEqual(result.exitCode, 1, name);
      assert.deepStrictEqual(result.err, [`Profile "${name}" is corrupted. Run "atris login" to fix.`], name);
      assert.deepStrictEqual(result.out, [], name);
    }
    assert.strictEqual(fs.existsSync(atrisPath(home, 'credentials.json')), false);
  });
});

test('switchAccount without --global only writes this terminal\'s session file', async () => {
  await withSandbox(async (home) => {
    writeProfile(home, 'bob', human('bob'));

    const result = await runSwitch(['bob']);

    assert.strictEqual(result.exitCode, null);
    assert.deepStrictEqual(result.out, ['Switched to bob@example.com']);
    const session = JSON.parse(fs.readFileSync(atrisPath(home, 'sessions', `${TERMINAL_ID}.json`), 'utf8'));
    assert.strictEqual(session.profile, 'bob');
    assert.strictEqual(fs.existsSync(atrisPath(home, 'credentials.json')), false);
  });
});

test('switchAccount treats -g like --global, in any position, and never as the account name', async () => {
  await withSandbox(async (home) => {
    const bob = human('bob');
    writeProfile(home, 'bob', bob);

    const result = await runSwitch(['-g', 'bob']);

    assert.strictEqual(result.exitCode, null);
    assert.deepStrictEqual(result.out, ['Switched to bob@example.com (global, all terminals)']);
    assert.deepStrictEqual(readGlobalCredentials(home), bob);
    assert.strictEqual(fs.existsSync(atrisPath(home, 'sessions', `${TERMINAL_ID}.json`)), false);
  });
});

test('switchAccount removes session files older than a week and keeps recent ones', async () => {
  await withSandbox(async (home) => {
    writeProfile(home, 'bob', human('bob'));
    const sessions = atrisPath(home, 'sessions');
    fs.mkdirSync(sessions, { recursive: true });
    const stale = path.join(sessions, 'old-terminal.json');
    const fresh = path.join(sessions, 'fresh-terminal.json');
    fs.writeFileSync(stale, JSON.stringify({ profile: 'bob' }));
    fs.writeFileSync(fresh, JSON.stringify({ profile: 'bob' }));
    const longAgo = new Date('2001-01-01T00:00:00Z');
    fs.utimesSync(stale, longAgo, longAgo);

    const result = await runSwitch(['bob', '--global']);

    assert.strictEqual(result.exitCode, null);
    assert.strictEqual(fs.existsSync(stale), false);
    assert.strictEqual(fs.existsSync(fresh), true);
  });
});

test('switchAccount switches to a saved agent client and labels it by client id', async () => {
  await withSandbox(async (home) => {
    const client = {
      auth_type: 'agent_client',
      client_id: 'atc_work1',
      client_secret_file: path.join(home, 'work1.secret'),
      scope: 'x-search',
      provider: 'agent_client',
      email: null,
      user_id: null,
    };
    writeProfile(home, 'atc_work1', client);

    const result = await runSwitch(['atc_work1', '--global']);

    assert.strictEqual(result.exitCode, null);
    assert.deepStrictEqual(result.out, ['Switched to agent client atc_work1 (global, all terminals)']);
    assert.deepStrictEqual(readGlobalCredentials(home), client);
  });
});

test('switchAccount saves an agent client login before replacing it', async () => {
  await withSandbox(async (home) => {
    const oldClient = {
      auth_type: 'agent_client',
      client_id: 'atc_old',
      client_secret_file: path.join(home, 'old.secret'),
      scope: null,
      provider: 'agent_client',
      email: null,
      user_id: null,
    };
    const bob = human('bob');
    writeProfile(home, 'bob', bob);
    writeGlobalCredentials(home, oldClient);

    const result = await runSwitch(['bob', '--global']);

    assert.strictEqual(result.exitCode, null);
    assert.deepStrictEqual(result.out, [
      'Switched to bob@example.com (global, all terminals)',
      'The agent client login is saved. Switch back: atris switch atc_old --global',
    ]);
    assert.deepStrictEqual(readGlobalCredentials(home), bob);
    const saved = JSON.parse(fs.readFileSync(atrisPath(home, 'profiles', 'atc_old.json'), 'utf8'));
    assert.deepStrictEqual(saved, oldClient);
  });
});
