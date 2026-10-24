'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// followCommand reads its arguments from process.argv and talks to the Atris
// API through utils/api + utils/auth. Both are replaced with in-memory fakes
// before social.js loads, so no test touches the network or real credentials.
const state = { creds: null, calls: [], route: () => ({ status: 200, data: {} }) };

function installFake(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

installFake('../utils/auth', { loadCredentials: () => state.creds });
installFake('../utils/api', {
  apiRequestJson: async (pathname, options = {}) => {
    state.calls.push({ pathname, method: options.method || 'GET', token: options.token });
    return state.route(pathname, options.method || 'GET');
  },
  getAppBaseUrl: () => 'https://atris.test',
});

const { followCommand } = require('../commands/social');

const UUID = '123e4567-e89b-12d3-a456-426614174000';
const savedEnv = {};
let tmpHome;

before(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-follow-'));
  savedEnv.HOME = process.env.HOME;
  process.env.HOME = tmpHome;
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('ATRIS_')) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  }
});

after(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

class ExitSignal extends Error {
  constructor(code) {
    super(`exit ${code}`);
    this.code = code;
  }
}

// Runs followCommand with the given CLI args and captures everything it does.
async function run(args, { route, creds = { token: 'tok-1' } } = {}) {
  state.creds = creds;
  state.calls = [];
  state.route = route || (() => ({ status: 200, data: {} }));

  const saved = {
    argv: process.argv,
    exit: process.exit,
    log: console.log,
    error: console.error,
  };
  const logs = [];
  const errors = [];
  let exitCode = null;

  process.argv = ['node', 'atris', 'follow', ...args];
  process.exit = (code) => { throw new ExitSignal(code); };
  console.log = (...parts) => logs.push(parts.join(' '));
  console.error = (...parts) => errors.push(parts.join(' '));
  try {
    await followCommand();
  } catch (err) {
    if (!(err instanceof ExitSignal)) throw err;
    exitCode = err.code;
  } finally {
    process.argv = saved.argv;
    process.exit = saved.exit;
    console.log = saved.log;
    console.error = saved.error;
  }
  return { logs, errors, exitCode, calls: state.calls };
}

test('follow by UUID posts the follow and reports a one-way follow', async () => {
  const out = await run([UUID], {
    route: (pathname) => (pathname.startsWith('/social/check/')
      ? { status: 200, data: { is_mutual: false } }
      : { status: 200, data: {} }),
  });

  assert.strictEqual(out.exitCode, null);
  assert.deepStrictEqual(out.calls, [
    { pathname: `/social/follow/${UUID}`, method: 'POST', token: 'tok-1' },
    { pathname: `/social/check/${UUID}`, method: 'GET', token: 'tok-1' },
  ]);
  assert.deepStrictEqual(out.logs, [
    `Now following ${UUID}. When they follow back, you're friends.`,
  ]);
  assert.deepStrictEqual(out.errors, []);
});

test('follow by name resolves the @username and says so when it is mutual', async () => {
  const people = [
    { id: UUID, username: 'ada', name: 'Ada Lovelace', email: 'ada@example.com' },
    { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', username: 'adam', name: 'Adam West' },
  ];
  const out = await run(['@ada'], {
    route: (pathname) => {
      if (pathname.startsWith('/social/search')) return { status: 200, data: people };
      if (pathname.startsWith('/social/check/')) return { status: 200, data: { is_mutual: true } };
      return { status: 200, data: {} };
    },
  });

  assert.strictEqual(out.exitCode, null);
  assert.deepStrictEqual(out.calls.map((c) => `${c.method} ${c.pathname}`), [
    'GET /social/search?q=ada',
    `POST /social/follow/${UUID}`,
    `GET /social/check/${UUID}`,
  ]);
  assert.deepStrictEqual(out.logs, [
    'You and Ada Lovelace (@ada) are now friends (you follow each other).',
  ]);
});

test('multiple words are joined into one search query', async () => {
  const out = await run(['Ada', 'Lovelace'], {
    route: (pathname) => (pathname.startsWith('/social/search')
      ? { status: 200, data: [{ id: UUID, username: 'ada', name: 'Ada Lovelace' }] }
      : { status: 200, data: {} }),
  });

  assert.strictEqual(out.exitCode, null);
  assert.strictEqual(out.calls[0].pathname, '/social/search?q=Ada%20Lovelace');
  assert.strictEqual(out.calls[1].method, 'POST');
  assert.match(out.logs[0], /^Now following Ada Lovelace \(@ada\)\./);
});

test('a single non-exact search hit is used as is', async () => {
  const out = await run(['lovel'], {
    route: (pathname) => (pathname.startsWith('/social/search')
      ? { status: 200, data: [{ id: UUID, email: 'ada@example.com' }] }
      : { status: 200, data: { is_mutual: false } }),
  });

  assert.strictEqual(out.exitCode, null);
  assert.deepStrictEqual(out.logs, [
    "Now following ada@example.com. When they follow back, you're friends.",
  ]);
});

test('a failed mutual check still reports a plain follow', async () => {
  const out = await run([UUID], {
    route: (pathname) => (pathname.startsWith('/social/check/')
      ? { status: 500, data: {} }
      : { status: 200, data: {} }),
  });

  assert.strictEqual(out.exitCode, null);
  assert.match(out.logs[0], /^Now following /);
});

test('no arguments prints usage and exits 2 without calling the API', async () => {
  const out = await run([]);

  assert.strictEqual(out.exitCode, 2);
  assert.deepStrictEqual(out.errors, ['Usage: atris follow <who>']);
  assert.deepStrictEqual(out.logs, []);
  assert.deepStrictEqual(out.calls, []);
});

test('help tokens print usage and exit 2 without calling the API', async () => {
  for (const token of ['--help', '-h', 'help']) {
    const out = await run([token]);
    assert.strictEqual(out.exitCode, 2, token);
    assert.deepStrictEqual(out.errors, ['Usage: atris follow <who>'], token);
    assert.deepStrictEqual(out.calls, [], token);
  }
});

test('help anywhere in the arguments wins over a name', async () => {
  const out = await run(['ada', '--help']);

  assert.strictEqual(out.exitCode, 2);
  assert.deepStrictEqual(out.calls, []);
});

test('no search results exits 1 and never tries to follow', async () => {
  const out = await run(['nobody'], {
    route: () => ({ status: 200, data: [] }),
  });

  assert.strictEqual(out.exitCode, 1);
  assert.deepStrictEqual(out.errors, ['No one found matching "nobody". Try: atris people <name>']);
  assert.deepStrictEqual(out.calls.map((c) => c.method), ['GET']);
});

test('a non-array search response is treated as no results', async () => {
  const out = await run(['ghost'], {
    route: () => ({ status: 200, data: { detail: 'weird' } }),
  });

  assert.strictEqual(out.exitCode, 1);
  assert.match(out.errors[0], /^No one found matching "ghost"/);
});

test('ambiguous matches list the candidates and do not guess', async () => {
  const out = await run(['sam'], {
    route: () => ({
      status: 200,
      data: [
        { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', username: 'sam1', name: 'Sam One', is_following: true },
        { id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', username: 'sam2', name: 'Sam Two', bio: 'builds things' },
      ],
    }),
  });

  assert.strictEqual(out.exitCode, 1);
  assert.deepStrictEqual(out.errors, [
    '"sam" matches 2 people:',
    '  Sam One (@sam1)  · following',
    '  Sam Two (@sam2)\n      builds things',
    'Be more specific (use the @username).',
  ]);
  assert.ok(out.calls.every((c) => c.method === 'GET'));
});

test('an exact username match beats other partial matches', async () => {
  const out = await run(['sam1'], {
    route: (pathname) => {
      if (pathname.startsWith('/social/search')) {
        return {
          status: 200,
          data: [
            { id: UUID, username: 'sam1', name: 'Sam One' },
            { id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', username: 'sam10', name: 'Sam Ten' },
          ],
        };
      }
      return { status: 200, data: { is_mutual: false } };
    },
  });

  assert.strictEqual(out.exitCode, null);
  assert.strictEqual(out.calls[1].pathname, `/social/follow/${UUID}`);
});

test('an API error on the follow call is shown and exits 1', async () => {
  const out = await run([UUID], {
    route: () => ({ status: 404, data: { detail: 'User not found' } }),
  });

  assert.strictEqual(out.exitCode, 1);
  assert.deepStrictEqual(out.errors, ['User not found']);
  assert.deepStrictEqual(out.logs, []);
  assert.strictEqual(out.calls.length, 1);
});

test('an API error without detail falls back to the status code', async () => {
  const out = await run([UUID], {
    route: () => ({ status: 429, data: null }),
  });

  assert.strictEqual(out.exitCode, 1);
  assert.deepStrictEqual(out.errors, ['Request failed (429)']);
});

test('a nested error message in the API reply is surfaced', async () => {
  const out = await run([UUID], {
    route: () => ({ status: 403, data: { detail: { error: { message: 'Cannot follow yourself' } } } }),
  });

  assert.strictEqual(out.exitCode, 1);
  assert.deepStrictEqual(out.errors, ['Cannot follow yourself']);
});

test('an expired session asks the user to log in again', async () => {
  const out = await run([UUID], {
    route: () => ({ status: 401, data: {} }),
  });

  assert.strictEqual(out.exitCode, 1);
  assert.deepStrictEqual(out.errors, ['Session expired. Run: atris login']);
});

test('without saved credentials it asks for login before any request', async () => {
  const out = await run([UUID], { creds: null });

  assert.strictEqual(out.exitCode, 1);
  assert.deepStrictEqual(out.errors, ['Not logged in. Run: atris login']);
  assert.deepStrictEqual(out.calls, []);
});

test('credentials without a token count as logged out', async () => {
  const out = await run([UUID], { creds: { email: 'a@b.co' } });

  assert.strictEqual(out.exitCode, 1);
  assert.deepStrictEqual(out.errors, ['Not logged in. Run: atris login']);
  assert.deepStrictEqual(out.calls, []);
});
