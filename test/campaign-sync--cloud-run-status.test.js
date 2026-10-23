'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { cloudRunStatus } = require('../lib/campaign-sync');

// Inject both helpers in every call: no login files, environment, or network.
test('cloudRunStatus returns run data and sends an authenticated GET', async () => {
  const data = { status: 'running', campaign_id: 'campaign-one' };
  const calls = [];
  const result = await cloudRunStatus('campaign-one', {
    loadCredentials: () => ({ token: '  test-token  ' }),
    apiRequestJson: async (...args) => {
      calls.push(args);
      return { ok: true, data };
    },
  });

  assert.deepStrictEqual(result, { ok: true, data });
  assert.deepStrictEqual(calls, [[
    '/campaigns/campaign-one/cloud-run',
    { method: 'GET', token: 'test-token', retries: 0, timeoutMs: 15000 },
  ]]);
});

test('cloudRunStatus encodes reserved characters and defaults missing data to an object', async () => {
  const calls = [];
  const result = await cloudRunStatus('a/b ?#%', {
    loadCredentials: () => ({ token: 'test-token' }),
    apiRequestJson: async (route) => {
      calls.push(route);
      return { ok: true };
    },
  });

  assert.deepStrictEqual(result, { ok: true, data: {} });
  assert.deepStrictEqual(calls, ['/campaigns/a%2Fb%20%3F%23%25/cloud-run']);
});

test('cloudRunStatus rejects absent, blank, or unreadable credentials without requesting', async () => {
  for (const loadCredentials of [
    () => null,
    () => ({}),
    () => ({ token: ' \t ' }),
    () => { throw new Error('unreadable login'); },
  ]) {
    let requested = false;
    const result = await cloudRunStatus('campaign-one', {
      loadCredentials,
      apiRequestJson: async () => { requested = true; return { ok: true }; },
    });

    assert.deepStrictEqual(result, {
      ok: false, status: 401, error: 'not logged in to Atris. run: atris login',
    });
    assert.strictEqual(requested, false);
  }
});

test('cloudRunStatus reports empty responses and cloud errors in plain words', async () => {
  const cases = [
    [undefined, 0, 'could not reach the Atris cloud'],
    [{ ok: false, status: 0, error: 'offline' }, 0, 'could not reach the Atris cloud (offline)'],
    [{ ok: false, status: 401, data: { error: 'internal detail' } }, 401,
      'the Atris cloud did not accept your login. run: atris login'],
    [{ ok: false, status: 404 }, 404,
      'the Atris cloud does not run campaigns on computers yet (404). Try again after the next backend deploy'],
    [{ ok: false, status: 404, data: { error: 'campaign not found' } }, 404, 'campaign not found'],
    [{ ok: false, status: 409, data: { detail: 'already running' } }, 409, 'already running'],
    [{ ok: false, status: 503 }, 503, 'the Atris cloud answered 503'],
  ];

  for (const [response, status, error] of cases) {
    const result = await cloudRunStatus('campaign-one', {
      loadCredentials: () => ({ token: 'test-token' }),
      apiRequestJson: async () => response,
    });
    assert.deepStrictEqual(result, { ok: false, status, error });
  }
});
