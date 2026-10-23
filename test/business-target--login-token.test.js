'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { loginToken } = require('../lib/business-target');

test('loginToken returns an explicit token without requesting credentials', async () => {
  const token = await loginToken({
    token: 'explicit-token',
    ensureCredentials() {
      assert.fail('explicit token must bypass credential lookup');
    },
  });
  assert.strictEqual(token, 'explicit-token');
});

test('loginToken resolves credentials when the explicit token is empty', async () => {
  let calls = 0;
  const token = await loginToken({
    token: '',
    async ensureCredentials() {
      calls += 1;
      return { credentials: { token: 'credential-token' } };
    },
  });
  assert.strictEqual(token, 'credential-token');
  assert.strictEqual(calls, 1);
});

test('loginToken returns an empty string for missing or failed credentials', async () => {
  const results = [
    null,
    undefined,
    {},
    { credentials: null },
    { credentials: {} },
    { credentials: { token: '' } },
    { error: 'login failed', credentials: { token: 'must-not-be-used' } },
  ];
  for (const result of results) {
    assert.strictEqual(await loginToken({ ensureCredentials: () => result }), '');
  }
});

test('loginToken propagates credential lookup failures', async () => {
  const failure = new Error('credential lookup failed');
  await assert.rejects(
    loginToken({ ensureCredentials: async () => { throw failure; } }),
    (error) => error === failure,
  );
});
