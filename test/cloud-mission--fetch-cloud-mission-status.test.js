'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { fetchCloudMissionStatus } = require('../lib/cloud-mission');

// Inject both boundaries so no credentials, environment, clock, or network are used.
test('returns the mission payload and sends an authenticated GET', async () => {
  const mission = {
    task_id: 'task-123', status: 'completed', lane: 'fast',
    result: { summary: 'finished' },
  };
  const calls = [];
  const result = await fetchCloudMissionStatus('task-123', {
    loadCredentials: () => ({ token: '  test-token  ' }),
    apiRequestJson: async (...args) => {
      calls.push(args);
      return { ok: true, data: mission };
    },
  });
  assert.strictEqual(result, mission);
  assert.deepStrictEqual(calls, [[
    '/atris2/missions/task-123', { method: 'GET', token: 'test-token' },
  ]]);
});

test('encodes reserved characters and Unicode in the task identifier', async () => {
  const mission = { task_id: 'a/b ?#%é', status: 'running' };
  let requestedPath;
  const result = await fetchCloudMissionStatus(mission.task_id, {
    loadCredentials: () => ({ token: 'test-token' }),
    apiRequestJson: async (pathname) => {
      requestedPath = pathname;
      return { ok: true, data: mission };
    },
  });
  assert.strictEqual(requestedPath, '/atris2/missions/a%2Fb%20%3F%23%25%C3%A9');
  assert.deepStrictEqual(result, mission);
});

test('rejects missing credentials before requesting a mission', async () => {
  for (const credentials of [null, {}, { token: '   ' }]) {
    let requested = false;
    await assert.rejects(fetchCloudMissionStatus('task-123', {
      loadCredentials: () => credentials,
      apiRequestJson: async () => { requested = true; },
    }), {
      name: 'CloudMissionError',
      message: 'not logged in. run: atris login',
      exitCode: 1,
    });
    assert.strictEqual(requested, false);
  }
});

test('rejects successful responses with empty or incomplete mission data', async () => {
  for (const data of [undefined, null, {}, { task_id: 'task-123' },
    { status: 'running' }, { task_id: '', status: 'running' },
    { task_id: 'task-123', status: '' }]) {
    await assert.rejects(fetchCloudMissionStatus('task-123', {
      loadCredentials: () => ({ token: 'test-token' }),
      apiRequestJson: async () => ({ ok: true, data }),
    }), {
      name: 'CloudMissionError',
      message: 'cloud mission response did not include task_id and status',
      exitCode: 1,
    });
  }
});

test('reports backend failures and gives the business attachment hint', async () => {
  await assert.rejects(fetchCloudMissionStatus('task-123', {
    loadCredentials: () => ({ token: 'test-token' }),
    apiRequestJson: async () => ({
      ok: false, status: 403, data: { detail: 'business required' },
    }),
  }), {
    name: 'CloudMissionError', exitCode: 1, status: 403,
    detail: 'business required',
    message: 'cloud mission request failed (403): business required\ntry: --agent <id of a business-attached agent>',
  });
});

test('reports an absent response with default error details', async () => {
  await assert.rejects(fetchCloudMissionStatus('task-123', {
    loadCredentials: () => ({ token: 'test-token' }),
    apiRequestJson: async () => undefined,
  }), {
    name: 'CloudMissionError', message: 'cloud mission request failed',
    exitCode: 1, status: 0, detail: '',
  });
});
