'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { updateCloudMission } = require('../lib/cloud-mission');

// Always inject both dependencies: no local credentials, environment, or network.
test('updateCloudMission posts the action and body and returns response data', async () => {
  const body = { reason: 'requirements changed', budget_usd: 0 };
  const data = { task_id: 'mission-1', status: 'cancelled' };
  const calls = [];
  const result = await updateCloudMission('mission-1', 'cancel', body, {
    loadCredentials: () => ({ token: '  test-token  ' }),
    apiRequestJson: async (...args) => {
      calls.push(args);
      return { ok: true, data };
    },
  });

  assert.deepStrictEqual(calls, [[
    '/mission-control/missions/mission-1/cancel',
    { method: 'POST', token: 'test-token', body },
  ]]);
  assert.strictEqual(result, data);
});

test('updateCloudMission encodes reserved characters in the mission id', async () => {
  const calls = [];
  const result = await updateCloudMission('a/b ?#%雪', 'pause', undefined, {
    loadCredentials: () => ({ token: 'test-token' }),
    apiRequestJson: async (...args) => {
      calls.push(args);
      return { ok: true, data: { status: 'paused' } };
    },
  });

  assert.deepStrictEqual(calls, [[
    '/mission-control/missions/a%2Fb%20%3F%23%25%E9%9B%AA/pause',
    { method: 'POST', token: 'test-token', body: {} },
  ]]);
  assert.deepStrictEqual(result, { status: 'paused' });
});

test('updateCloudMission returns an empty object for successful responses without data', async () => {
  for (const response of [{ ok: true }, { ok: true, data: null }]) {
    const result = await updateCloudMission('mission-1', 'resume', {}, {
      loadCredentials: () => ({ token: 'test-token' }),
      apiRequestJson: async () => response,
    });
    assert.deepStrictEqual(result, {});
  }
});

test('updateCloudMission rejects missing or blank credentials before requesting', async () => {
  for (const credentials of [null, {}, { token: '   ' }]) {
    let requested = false;
    await assert.rejects(updateCloudMission('mission-1', 'pause', {}, {
      loadCredentials: () => credentials,
      apiRequestJson: async () => {
        requested = true;
        return { ok: true, data: {} };
      },
    }), {
      name: 'CloudMissionError',
      message: 'not logged in. run: atris login',
      exitCode: 1,
    });
    assert.strictEqual(requested, false);
  }
});

test('updateCloudMission exposes request failure details and handles an absent response', async () => {
  for (const [response, expected] of [
    [{ ok: false, status: 403, data: { detail: 'business required' } }, {
      message: 'cloud mission request failed (403): business required\ntry: --agent <id of a business-attached agent>',
      status: 403,
      detail: 'business required',
    }],
    [undefined, { message: 'cloud mission request failed', status: 0, detail: '' }],
  ]) {
    await assert.rejects(updateCloudMission('mission-1', 'resume', {}, {
      loadCredentials: () => ({ token: 'test-token' }),
      apiRequestJson: async () => response,
    }), { name: 'CloudMissionError', exitCode: 1, ...expected });
  }
});
