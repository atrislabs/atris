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

test('signed in, usage shows one line per key and a total, not raw data', async () => {
  const out = [];
  const code = await usageCommand([], {
    env: {},
    log: (line) => out.push(String(line)),
    err: () => {},
    loadCredentials: () => ({ token: 'eyJ.login.jwt' }),
    apiRequestJson: async () => ({ ok: true, data: { agent_id: null, agent_name: null, usage: {
      keys: [
        { agent_id: 'a1', agent_name: 'memory', usage: { api_key: 'atris_aLBO...', total_requests: 3, error_count: 1 } },
        { agent_id: 'a2', agent_name: 'smoke', usage: { api_key: 'atris_yYPV...', total_requests: 0, error_count: 0 } },
      ],
      total: { period_days: 30, total_requests: 3, error_count: 1, error_rate: 33.33, endpoints: { '/v1/chat': 3 } },
    } } }),
  });
  assert.equal(code, 0);
  const text = out.join('\n');
  assert.match(text, /^last 30 days, 2 developer keys:/);
  assert.match(text, /memory \(atris_aLBO\.\.\.\): 3 requests, 1 error/);
  assert.match(text, /smoke \(atris_yYPV\.\.\.\): 0 requests$/m);
  assert.match(text, /total: 3 requests, 1 error \(33\.33%\)/);
  assert.match(text, /busiest: \/v1\/chat 3/);
  assert.doesNotMatch(text, /\{"/);
});
