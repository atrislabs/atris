'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-enqueue-cloud-mission-'));
process.env.HOME = home;
for (const key of Object.keys(process.env)) {
  if (key.startsWith('ATRIS_')) delete process.env[key];
}

const { enqueueCloudMission, RECEIPT_VOICE_CONTRACT } = require('../lib/cloud-mission');

test('enqueueCloudMission posts the mission and returns the cloud payload', async () => {
  const calls = [];
  const payload = { task_id: 'task-1', status: 'pending', lane: 'pro' };
  const mission = await enqueueCloudMission({
    text: 'Make the home page clearer',
    lane: 'pro',
    agentId: 'agent-7',
    businessId: 'business-1',
    idempotencyKey: 'key-fixed-1',
    budgetUsd: 2,
  }, {
    loadCredentials: () => ({ token: '  test-token  ' }),
    apiRequestJson: async (pathname, options) => {
      calls.push({ pathname, options });
      return { ok: true, status: 200, data: payload };
    },
  });

  assert.strictEqual(mission, payload);
  assert.deepStrictEqual(calls, [{
    pathname: '/atris2/missions',
    options: {
      method: 'POST',
      token: 'test-token',
      body: {
        text: `Make the home page clearer\n\n${RECEIPT_VOICE_CONTRACT}`,
        lane: 'pro',
        agent_id: 'agent-7',
        business_id: 'business-1',
        idempotency_key: 'key-fixed-1',
        budget_usd: 2,
      },
    },
  }]);
});

test('enqueueCloudMission keeps empty optional fields and does not repeat the receipt contract', async () => {
  const calls = [];
  const text = `keep this wording\n\n${RECEIPT_VOICE_CONTRACT}`;
  const mission = await enqueueCloudMission({
    text: `  ${text}  `,
    agentId: '',
    businessId: null,
    idempotencyKey: '',
    budgetUsd: 0,
  }, {
    loadCredentials: () => ({ token: 'edge-token' }),
    apiRequestJson: async (pathname, options) => {
      calls.push({ pathname, options });
      return { ok: true, status: 200, data: { task_id: 'task-edge', lane: 'fast' } };
    },
  });

  assert.deepStrictEqual(mission, { task_id: 'task-edge', lane: 'fast' });
  assert.deepStrictEqual(calls, [{
    pathname: '/atris2/missions',
    options: {
      method: 'POST',
      token: 'edge-token',
      body: {
        text,
        lane: 'fast',
        idempotency_key: '',
        budget_usd: 0,
      },
    },
  }]);
  assert.strictEqual(calls[0].options.body.text.split(RECEIPT_VOICE_CONTRACT).length, 2);

  const blankCalls = [];
  const blank = await enqueueCloudMission({ text: ' \n\t ' }, {
    loadCredentials: () => ({ token: 'blank-token' }),
    apiRequestJson: async (pathname, options) => {
      blankCalls.push({ pathname, options });
      return { ok: true, status: 200, data: { task_id: 'task-blank' } };
    },
  });

  assert.deepStrictEqual(blank, { task_id: 'task-blank' });
  assert.deepStrictEqual(blankCalls, [{
    pathname: '/atris2/missions',
    options: {
      method: 'POST',
      token: 'blank-token',
      body: { text: '', lane: 'fast' },
    },
  }]);
});

test('enqueueCloudMission rejects a bad lane, a missing login, and a bad cloud response', async () => {
  let credentialReads = 0;
  let requests = 0;
  const deps = {
    loadCredentials: () => {
      credentialReads += 1;
      return { token: 'unused-token' };
    },
    apiRequestJson: async () => {
      requests += 1;
      return { ok: true, status: 200, data: { task_id: 'should-not-send' } };
    },
  };

  await assert.rejects(
    () => enqueueCloudMission({ text: 'do work', lane: 'turbo' }, deps),
    (err) => {
      assert.strictEqual(err.name, 'CloudMissionError');
      assert.strictEqual(err.exitCode, 2);
      assert.strictEqual(err.message, 'invalid --lane "turbo". expected fast, pro, or max');
      return true;
    },
  );
  assert.strictEqual(credentialReads, 0);
  assert.strictEqual(requests, 0);

  await assert.rejects(
    () => enqueueCloudMission({ text: 'do work' }, {
      loadCredentials: () => ({ token: '   ' }),
      apiRequestJson: async () => {
        requests += 1;
        return { ok: true, status: 200, data: { task_id: 'should-not-send' } };
      },
    }),
    (err) => {
      assert.strictEqual(err.name, 'CloudMissionError');
      assert.strictEqual(err.exitCode, 1);
      assert.strictEqual(err.message, 'not logged in. run: atris login');
      return true;
    },
  );
  assert.strictEqual(requests, 0);

  await assert.rejects(
    () => enqueueCloudMission({ text: 'do work' }, {
      loadCredentials: () => ({ token: 'fail-token' }),
      apiRequestJson: async () => ({
        ok: false,
        status: 409,
        error: 'business is not attached',
      }),
    }),
    (err) => {
      assert.strictEqual(err.name, 'CloudMissionError');
      assert.strictEqual(err.exitCode, 1);
      assert.strictEqual(err.status, 409);
      assert.strictEqual(err.detail, 'business is not attached');
      assert.strictEqual(
        err.message,
        'cloud mission request failed (409): business is not attached\ntry: --agent <id of a business-attached agent>',
      );
      return true;
    },
  );

  await assert.rejects(
    () => enqueueCloudMission({ text: 'do work' }, {
      loadCredentials: () => ({ token: 'empty-token' }),
      apiRequestJson: async () => ({ ok: true, status: 200, data: { status: 'pending' } }),
    }),
    (err) => {
      assert.strictEqual(err.name, 'CloudMissionError');
      assert.strictEqual(err.exitCode, 1);
      assert.strictEqual(err.message, 'cloud mission response did not include task_id');
      return true;
    },
  );
});
