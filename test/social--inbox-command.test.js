const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Replace only external boundaries before social.js destructures its imports.
// Each invocation restores the cache, environment, and process/console hooks.
async function runInbox(response, args = []) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-social-inbox-'));
  const savedEnv = { ...process.env };
  const savedArgv = process.argv;
  const savedLog = console.log;
  const savedError = console.error;
  const savedExit = process.exit;
  const ids = ['../commands/social', '../utils/auth', '../utils/api'].map(require.resolve);
  const cached = ids.map((id) => require.cache[id]);
  const logs = [];
  const errors = [];
  const requests = [];
  const exitSignal = new Error('intercepted process.exit');
  let exitCode;
  try {
    process.env.HOME = home;
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('ATRIS_')) delete process.env[key];
    }
    process.argv = [process.execPath, 'atris', 'inbox', ...args];
    console.log = (...values) => logs.push(values.join(' '));
    console.error = (...values) => errors.push(values.join(' '));
    process.exit = (code) => { exitCode = code; throw exitSignal; };
    delete require.cache[ids[0]];
    require.cache[ids[1]] = {
      id: ids[1], filename: ids[1], loaded: true,
      exports: { loadCredentials: () => ({ token: 'fixture-token' }) },
    };
    require.cache[ids[2]] = {
      id: ids[2], filename: ids[2], loaded: true,
      exports: {
        apiRequestJson: async (pathname, options) => {
          requests.push({ pathname, options });
          return response;
        },
      },
    };
    const { inboxCommand } = require('../commands/social');
    try {
      await inboxCommand();
    } catch (error) {
      if (error !== exitSignal) throw error;
    }
    return { logs, errors, requests, exitCode };
  } finally {
    ids.forEach((id, index) => {
      if (cached[index]) require.cache[id] = cached[index];
      else delete require.cache[id];
    });
    process.argv = savedArgv;
    console.log = savedLog;
    console.error = savedError;
    process.exit = savedExit;
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key];
    }
    Object.assign(process.env, savedEnv);
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('inbox lists conversations by unread count and truncates previews to 80 characters', async () => {
  const result = await runInbox({ status: 200, data: { conversations: [
    { other_user: { name: 'Alice', username: 'alice' }, unread_count: 0, last_message_preview: 'Already read' },
    { other_user: { name: 'Bob', username: 'bob' }, unread_count: 3, last_message_preview: 'x'.repeat(81) },
    { other_user: { name: 'Carol' }, unread_count: 1 },
  ] } });
  assert.deepStrictEqual(result.logs, [
    'Conversations (3):\n',
    `  Bob (@bob)  · 3 unread\n      ${'x'.repeat(80)}`,
    '  Carol  · 1 unread',
    '  Alice (@alice)\n      Already read',
    '\nRead one: atris msg <who>',
  ]);
  assert.deepStrictEqual(result.requests, [
    { pathname: '/dm/conversations', options: { token: 'fixture-token' } },
  ]);
  assert.deepStrictEqual(result.errors, []);
  assert.strictEqual(result.exitCode, undefined);
});

test('inbox handles missing unread counts and falls back through available user labels', async () => {
  const result = await runInbox({ status: 200, data: { conversations: [
    { other_user: { display_name: 'Display', username: 'handle' } },
    { other_user: { username: 'only-handle' }, last_message_preview: '' },
    { other_user: { email: 'person@example.test' } },
    { other_user: { id: 'user-id' } },
  ] } });
  assert.deepStrictEqual(result.logs, [
    'Conversations (4):\n',
    '  Display (@handle)',
    '  @only-handle',
    '  person@example.test',
    '  user-id',
    '\nRead one: atris msg <who>',
  ]);
  assert.deepStrictEqual(result.errors, []);
  assert.strictEqual(result.exitCode, undefined);
});

test('inbox gives a next step for empty or missing conversation data', async () => {
  for (const data of [{ conversations: [] }, {}, null]) {
    const result = await runInbox({ status: 200, data });
    assert.deepStrictEqual(result.logs, ['No conversations yet. Start one: atris msg <who> "hello"']);
    assert.deepStrictEqual(result.errors, []);
    assert.strictEqual(result.exitCode, undefined);
    assert.strictEqual(result.requests.length, 1);
  }
});

test('inbox reports API error details and falls back to the response status', async () => {
  for (const [response, expected] of [
    [{ status: 403, data: { detail: 'Access denied' } }, 'Access denied'],
    [{ status: 500, data: { error: { message: 'Inbox unavailable' } } }, 'Inbox unavailable'],
    [{ status: 503, data: null }, 'Request failed (503)'],
    [{ status: 401, data: null }, 'Session expired. Run: atris login'],
  ]) {
    const result = await runInbox(response);
    assert.deepStrictEqual(result.logs, []);
    assert.deepStrictEqual(result.errors, [expected]);
    assert.strictEqual(result.exitCode, 1);
    assert.strictEqual(result.requests.length, 1);
  }
});
