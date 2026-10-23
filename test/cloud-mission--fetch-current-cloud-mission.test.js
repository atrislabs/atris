'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { fetchCurrentCloudMission } = require('../lib/cloud-mission');

// Inject both external boundaries so no credentials, environment, or network
// are consulted. The function's validation and error handling run unchanged.
function dependencies(response) {
  return {
    loadCredentials: () => ({ token: 'test-token' }),
    apiRequestJson: async () => response,
  };
}

test('fetches the current mission with a trimmed token and preserves its payload', async () => {
  const data = { mission_id: 'mission-1', status: 'running', summary: 'in progress' };
  const calls = [];
  const result = await fetchCurrentCloudMission({
    loadCredentials: () => ({ token: '  test-token \n' }),
    apiRequestJson: async (...args) => {
      calls.push(args);
      return { ok: true, data };
    },
  });

  assert.strictEqual(result, data);
  assert.deepStrictEqual(calls, [
    ['/atris2/missions/current', { method: 'GET', token: 'test-token' }],
  ]);
});

test('accepts each supported alternate mission response shape', async () => {
  for (const data of [
    { task_id: 'task-1' },
    { id: 'mission-1' },
    { mission: { id: 'mission-1' } },
    { card: { title: 'current mission' } },
  ]) {
    assert.strictEqual(
      await fetchCurrentCloudMission(dependencies({ ok: true, data })),
      data,
    );
  }
});

test('rejects successful responses that contain no mission', async () => {
  for (const data of [undefined, null, {}, { status: 'running' },
    { mission_id: '', task_id: null, id: 0, mission: false, card: null }]) {
    await assert.rejects(
      fetchCurrentCloudMission(dependencies({ ok: true, data })),
      {
        name: 'CloudMissionError',
        message: 'current cloud mission response did not include a mission',
        exitCode: 1,
      },
    );
  }
});

test('rejects missing credentials before attempting a request', async () => {
  let requests = 0;
  for (const credentials of [undefined, null, {}, { token: ' \n ' }]) {
    await assert.rejects(fetchCurrentCloudMission({
      loadCredentials: () => credentials,
      apiRequestJson: async () => { requests += 1; },
    }), {
      name: 'CloudMissionError',
      message: 'not logged in. run: atris login',
      exitCode: 1,
    });
  }
  assert.strictEqual(requests, 0);
});

test('reports backend errors with status, detail, and business guidance', async () => {
  await assert.rejects(fetchCurrentCloudMission(dependencies({
    ok: false,
    status: 403,
    data: { detail: 'business required' },
  })), {
    name: 'CloudMissionError',
    message: 'cloud mission request failed (403): business required\ntry: --agent <id of a business-attached agent>',
    exitCode: 1,
    status: 403,
    detail: 'business required',
  });
});

test('reports an absent response as a request failure', async () => {
  await assert.rejects(fetchCurrentCloudMission(dependencies(undefined)), {
    name: 'CloudMissionError',
    message: 'cloud mission request failed',
    exitCode: 1,
    status: 0,
    detail: '',
  });
});
