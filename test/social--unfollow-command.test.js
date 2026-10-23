'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const userId = '12345678-1234-1234-1234-123456789abc';

// Stub only the authentication/API boundary, leaving argument parsing,
// user resolution, output, and error handling in the real command.
function setup(t, args, responses = []) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-unfollow-'));
  const savedEnv = { ...process.env };
  const savedArgv = process.argv;
  const socialPath = require.resolve('../commands/social');
  const cachedSocial = require.cache[socialPath];
  t.after(() => {
    t.mock.restoreAll();
    process.argv = savedArgv;
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key];
    }
    Object.assign(process.env, savedEnv);
    delete require.cache[socialPath];
    if (cachedSocial) require.cache[socialPath] = cachedSocial;
    fs.rmSync(home, { recursive: true, force: true });
  });
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('ATRIS_')) delete process.env[key];
  }
  process.env.HOME = home;
  process.argv = [process.execPath, 'atris', 'unfollow', ...args];

  const calls = [];
  const logs = [];
  const errors = [];
  const exitSignal = new Error('command exited');
  const exits = [];
  t.mock.method(require('../utils/auth'), 'loadCredentials', () => ({ token: 'test-token' }));
  t.mock.method(require('../utils/api'), 'apiRequestJson', async (pathname, options) => {
    calls.push({ pathname, options });
    assert.ok(calls.length <= responses.length, 'unexpected API call');
    return responses[calls.length - 1];
  });
  t.mock.method(console, 'log', (...values) => logs.push(values.join(' ')));
  t.mock.method(console, 'error', (...values) => errors.push(values.join(' ')));
  t.mock.method(process, 'exit', (code) => {
    exits.push(code);
    throw exitSignal;
  });
  delete require.cache[socialPath];
  const { unfollowCommand } = require('../commands/social');
  return { unfollowCommand, calls, logs, errors, exits, exitSignal };
}

test('unfollow deletes a UUID directly and prints confirmation without a follow check', async (t) => {
  const run = setup(t, [userId], [{ status: 204, data: null }]);
  assert.strictEqual(await run.unfollowCommand(), undefined);
  assert.deepStrictEqual(run.calls, [{
    pathname: `/social/follow/${userId}`,
    options: { method: 'DELETE', token: 'test-token' },
  }]);
  assert.deepStrictEqual(run.logs, [`Unfollowed ${userId}.`]);
  assert.deepStrictEqual(run.errors, []);
  assert.deepStrictEqual(run.exits, []);
});

test('unfollow joins name arguments and chooses the case-insensitive exact match', async (t) => {
  const run = setup(t, ['Ada', 'Lovelace'], [
    { status: 200, data: [
      { id: 'other', name: 'Ada Lovelace Fan' },
      { id: userId, name: 'ADA LOVELACE', username: 'ada' },
    ] },
    { status: 200, data: {} },
  ]);
  await run.unfollowCommand();
  assert.deepStrictEqual(run.calls, [
    { pathname: '/social/search?q=Ada%20Lovelace', options: { token: 'test-token' } },
    { pathname: `/social/follow/${userId}`, options: { method: 'DELETE', token: 'test-token' } },
  ]);
  assert.deepStrictEqual(run.logs, ['Unfollowed ADA LOVELACE (@ada).']);
  assert.deepStrictEqual(run.errors, []);
  assert.deepStrictEqual(run.exits, []);
});

test('unfollow rejects empty input and help flags before any API request', async (t) => {
  for (const args of [[], ['--help'], ['someone', '-h']]) {
    await t.test(JSON.stringify(args), async (t) => {
      const run = setup(t, args);
      await assert.rejects(run.unfollowCommand(), (error) => error === run.exitSignal);
      assert.deepStrictEqual(run.errors, ['Usage: atris unfollow <who>']);
      assert.deepStrictEqual(run.exits, [2]);
      assert.deepStrictEqual(run.logs, []);
      assert.deepStrictEqual(run.calls, []);
    });
  }
});

test('unfollow reports a server error without printing success', async (t) => {
  const run = setup(t, [userId], [
    { status: 403, data: { detail: { error: { message: 'Unfollow denied' } } } },
  ]);
  await assert.rejects(run.unfollowCommand(), (error) => error === run.exitSignal);
  assert.deepStrictEqual(run.errors, ['Unfollow denied']);
  assert.deepStrictEqual(run.exits, [1]);
  assert.deepStrictEqual(run.logs, []);
  assert.deepStrictEqual(run.calls, [{
    pathname: `/social/follow/${userId}`,
    options: { method: 'DELETE', token: 'test-token' },
  }]);
});
