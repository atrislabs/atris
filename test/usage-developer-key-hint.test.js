'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { usageCommand } = require('../commands/usage');

test('a sign-in refused by usage comes back with how to get a developer key', async () => {
  const err = [];
  const calls = [];
  const code = await usageCommand([], {
    env: {},
    log: () => {},
    err: (line) => err.push(String(line)),
    loadCredentials: () => ({ token: 'eyJ.login.jwt' }),
    apiRequestJson: async (pathname, options) => { calls.push(options); return { ok: false, status: 401, error: 'X-API-Key header required' }; },
  });
  assert.equal(code, 1);
  assert.equal(calls[0].token, 'eyJ.login.jwt');
  assert.match(err.join('\n'), /X-API-Key header required\. usage is counted per developer key, not per sign-in\. make one with atris api-key create/);
});

test('with ATRIS_API_KEY set, usage sends it as X-API-Key even when not signed in', async () => {
  const calls = [];
  const code = await usageCommand([], {
    env: { ATRIS_API_KEY: 'atris_devkey' },
    log: () => {},
    err: () => {},
    loadCredentials: () => null,
    apiRequestJson: async (pathname, options) => { calls.push(options); return { ok: true, data: { usage: { requests: 3 } } }; },
  });
  assert.equal(code, 0);
  assert.equal(calls[0].headers['X-API-Key'], 'atris_devkey');
  assert.equal(calls[0].token, undefined);
});
