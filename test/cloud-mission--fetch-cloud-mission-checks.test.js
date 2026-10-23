'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { fetchCloudMissionChecks } = require('../lib/cloud-mission');

// Both dependencies are supplied on every call, avoiding local credentials,
// environment settings, and network requests entirely.
test('returns mission checks and sends an authenticated GET request', async () => {
  const data = { mission_id: 'mission-1', checks: [{ name: 'proof', passed: true }] };
  const calls = [];
  const result = await fetchCloudMissionChecks('mission-1', {
    loadCredentials: () => ({ token: '  test-token \n' }),
    apiRequestJson: async (...args) => {
      calls.push(args);
      return { ok: true, data };
    },
  });

  assert.deepStrictEqual(result, data);
  assert.deepStrictEqual(calls, [[
    '/mission-control/missions/mission-1',
    { method: 'GET', token: 'test-token' },
  ]]);
});

test('encodes reserved characters and unicode in the mission identifier', async () => {
  let requestedPath;
  const result = await fetchCloudMissionChecks('team/a b?x=1#é%', {
    loadCredentials: () => ({ token: 'test-token' }),
    apiRequestJson: async (pathname) => {
      requestedPath = pathname;
      return { ok: true, data: { checks: [] } };
    },
  });

  assert.strictEqual(requestedPath, '/mission-control/missions/team%2Fa%20b%3Fx%3D1%23%C3%A9%25');
  assert.deepStrictEqual(result, { checks: [] });
});

test('returns an empty object when a successful response has no data', async () => {
  for (const response of [{ ok: true }, { ok: true, data: null }]) {
    const result = await fetchCloudMissionChecks('mission-1', {
      loadCredentials: () => ({ token: 'test-token' }),
      apiRequestJson: async () => response,
    });
    assert.deepStrictEqual(result, {});
  }
});

test('rejects missing or blank credentials before making a request', async () => {
  let requests = 0;
  for (const credentials of [null, {}, { token: ' \n ' }]) {
    await assert.rejects(fetchCloudMissionChecks('mission-1', {
      loadCredentials: () => credentials,
      apiRequestJson: async () => {
        requests += 1;
        return { ok: true, data: {} };
      },
    }), {
      name: 'CloudMissionError',
      message: 'not logged in. run: atris login',
      exitCode: 1,
    });
  }
  assert.strictEqual(requests, 0);
});

test('includes backend failure details and the business agent hint', async () => {
  await assert.rejects(fetchCloudMissionChecks('mission-1', {
    loadCredentials: () => ({ token: 'test-token' }),
    apiRequestJson: async () => ({
      ok: false,
      status: 403,
      data: { detail: 'business access required' },
    }),
  }), {
    name: 'CloudMissionError',
    message: 'cloud mission request failed (403): business access required\ntry: --agent <id of a business-attached agent>',
    exitCode: 1,
    status: 403,
    detail: 'business access required',
  });
});

test('rejects an absent response with a structured request error', async () => {
  await assert.rejects(fetchCloudMissionChecks('mission-1', {
    loadCredentials: () => ({ token: 'test-token' }),
    apiRequestJson: async () => undefined,
  }), {
    name: 'CloudMissionError',
    message: 'cloud mission request failed',
    exitCode: 1,
    status: 0,
    detail: '',
  });
});
