'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const userId = '12345678-1234-1234-1234-123456789abc';
const conversation = { id: 'conversation-1', other_user: { name: 'Ada', username: 'ada' } };

// Substitute only external boundaries. The real command parses argv, builds
// requests, handles responses, and prints output. No auth or HTTP module runs.
async function invoke(args, responses, check) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-msg-test-'));
  const savedEnv = { ...process.env };
  const savedArgv = process.argv;
  const ids = ['../commands/social', '../utils/auth', '../utils/api'].map(require.resolve);
  const savedModules = ids.map(id => require.cache[id]);
  const savedLog = console.log;
  const savedError = console.error;
  const savedExit = process.exit;
  const output = [];
  const errors = [];
  const calls = [];
  const exitSignal = new Error('intercepted process.exit');
  let exitCode;
  try {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('ATRIS_')) delete process.env[key];
    }
    process.env.HOME = home;
    process.argv = [process.execPath, 'atris', 'msg', ...args];
    require.cache[ids[1]] = { loaded: true, exports: { loadCredentials: () => ({ token: 'test-token' }) } };
    require.cache[ids[2]] = { loaded: true, exports: {
      getAppBaseUrl: () => { throw new Error('unexpected app URL lookup'); },
      apiRequestJson: async (pathname, options) => {
        calls.push({ pathname, options });
        assert.ok(calls.length <= responses.length, 'unexpected API request');
        return responses[calls.length - 1];
      },
    } };
    delete require.cache[ids[0]];
    console.log = (...parts) => output.push(parts.join(' '));
    console.error = (...parts) => errors.push(parts.join(' '));
    process.exit = code => { exitCode = code; throw exitSignal; };
    const { msgCommand } = require('../commands/social');
    try {
      await msgCommand();
    } catch (error) {
      if (error !== exitSignal) throw error;
    }
    assert.strictEqual(calls.length, responses.length, 'all expected requests were made');
    await check({ output, errors, calls, exitCode });
  } finally {
    console.log = savedLog;
    console.error = savedError;
    process.exit = savedExit;
    process.argv = savedArgv;
    ids.forEach((id, index) => {
      if (savedModules[index]) require.cache[id] = savedModules[index];
      else delete require.cache[id];
    });
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key];
    }
    Object.assign(process.env, savedEnv);
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('msgCommand sends joined message words to a UUID recipient', async () => {
  await invoke([userId, 'hello', 'Ada!'], [
    { status: 200, data: conversation },
    { status: 201, data: {} },
  ], ({ output, errors, calls, exitCode }) => {
    assert.deepStrictEqual(calls, [
      { pathname: '/dm/conversations', options: {
        method: 'POST', body: { user_id: userId }, token: 'test-token',
      } },
      { pathname: '/dm/conversations/conversation-1/messages', options: {
        method: 'POST', body: { content: 'hello Ada!', content_type: 'text' }, token: 'test-token',
      } },
    ]);
    assert.deepStrictEqual(output, ['Sent to Ada (@ada).']);
    assert.deepStrictEqual(errors, []);
    assert.strictEqual(exitCode, undefined);
  });
});

test('msgCommand with no text reads an empty conversation without marking it read', async () => {
  await invoke([userId], [
    { status: 200, data: conversation },
    { status: 200, data: { messages: [] } },
  ], ({ output, errors, calls, exitCode }) => {
    assert.deepStrictEqual(calls[1], {
      pathname: '/dm/conversations/conversation-1/messages?limit=30',
      options: { token: 'test-token' },
    });
    assert.deepStrictEqual(output, [
      `No messages with Ada (@ada) yet. Send one: atris msg ${userId} "hello"`,
    ]);
    assert.deepStrictEqual(errors, []);
    assert.strictEqual(exitCode, undefined);
  });
});

test('msgCommand rejects missing recipients and help anywhere before contacting the API', async () => {
  for (const args of [[], ['--help'], [userId, 'hello', '-h']]) {
    await invoke(args, [], ({ output, errors, exitCode }) => {
      assert.deepStrictEqual(output, []);
      assert.deepStrictEqual(errors, ['Usage: atris msg <who> [message]']);
      assert.strictEqual(exitCode, 2);
    });
  }
});

test('msgCommand reports a rejected send without printing success', async () => {
  await invoke([userId, 'hello'], [
    { status: 200, data: conversation },
    { status: 403, data: { detail: { error: { message: 'Messaging is disabled.' } } } },
  ], ({ output, errors, exitCode }) => {
    assert.deepStrictEqual(output, []);
    assert.deepStrictEqual(errors, ['Messaging is disabled.']);
    assert.strictEqual(exitCode, 1);
  });
});
