'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'campaign-person-action-'));
const savedEnv = Object.fromEntries(Object.entries(process.env)
  .filter(([key]) => key === 'HOME' || key.startsWith('ATRIS_')));
for (const key of Object.keys(process.env)) {
  if (key.startsWith('ATRIS_')) delete process.env[key];
}
process.env.HOME = home;
const { sendPersonAction } = require('../lib/campaign-sync');
after(() => {
  delete process.env.HOME;
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('ATRIS_')) delete process.env[key];
  }
  Object.assign(process.env, savedEnv);
  fs.rmSync(home, { recursive: true, force: true });
});

const campaignId = 'campaign /one';
const base = '/campaigns/campaign%20%2Fone';
const fixedDate = '2025-01-02T03:04:05.000Z';

function fixture(responses) {
  const calls = [];
  const meta = new Map([[
    `campaign_sync:${campaignId}`,
    JSON.stringify({ pushed: 1, last_seq: 7, link: { url: 'https://example.test/campaign', linked_at: fixedDate } }),
  ]]);
  const store = {
    getMeta: (key) => meta.get(key),
    setMeta: (key, value) => meta.set(key, value),
    read: () => [{ id: 'existing-event', campaign_id: campaignId }],
    ingest: () => assert.fail('an empty pull must not ingest events'),
  };
  const deps = {
    now: () => fixedDate,
    loadCredentials: () => ({ token: '  person-token  ' }),
    apiRequestJson: async (route, options) => {
      calls.push({ route, options });
      assert.ok(responses.length, 'unexpected request');
      return responses.shift();
    },
  };
  return { store, deps, calls, meta };
}

function post(body) {
  return { method: 'POST', token: 'person-token', retries: 0, timeoutMs: 15000, body };
}

 test('sends an encoded ask answer and synchronizes an empty pull', async () => {
  const f = fixture([{ ok: true }, { ok: true, data: { events: [], last_event_seq: 9 } }]);
  const result = await sendPersonAction(f.store, campaignId, { ask_id: 'ask /two', answer: 'yes' }, f.deps);
  assert.deepStrictEqual(f.calls, [
    { route: `${base}/asks/ask%20%2Ftwo/answer`, options: post({ answer: 'yes' }) },
    { route: `${base}/events?after=7&limit=500`, options: { method: 'GET', token: 'person-token', retries: 0, timeoutMs: 15000 } },
  ]);
  assert.deepStrictEqual(result, { ok: true, sync: {
    ok: true, campaign_id: campaignId, pushed: 0, duplicates: 0, held: 0,
    pulled: 0, last_seq: 9, link: 'https://example.test/campaign',
  } });
  const state = JSON.parse(f.meta.get(`campaign_sync:${campaignId}`));
  assert.strictEqual(state.last_seq, 9);
  assert.strictEqual(state.synced_at, fixedDate);
});

test('preserves a zero budget and reports a failed follow-up sync as a warning', async () => {
  const f = fixture([{ ok: true }, { ok: false, status: 403, data: { detail: 'sync denied' } }]);
  const result = await sendPersonAction(f.store, campaignId, { action: 'add_budget', amount_usd: 0 }, f.deps);
  assert.deepStrictEqual(f.calls[0], { route: `${base}/actions`, options: post({ action: 'add_budget', amount_usd: 0 }) });
  assert.strictEqual(f.calls.length, 2);
  assert.deepStrictEqual(result, { ok: true, sync: {
    ok: false, campaign_id: campaignId, pushed: 0, duplicates: 0, held: 0,
    pulled: 0, last_seq: 7, link: 'https://example.test/campaign', status: 403,
    error: 'the Atris cloud refused this (403): sync denied',
  }, warning: 'the Atris cloud refused this (403): sync denied' });
});

test('returns cloud rejection or an empty response without attempting sync', async () => {
  for (const [response, expected] of [
    [{ ok: false, status: 409, data: { error: 'conflict' } }, { ok: false, status: 409, error: 'the Atris cloud holds a different event at the same place (409): conflict' }],
    [undefined, { ok: false, status: 0, error: 'could not reach the Atris cloud' }],
  ]) {
    const f = fixture([response]);
    assert.deepStrictEqual(await sendPersonAction(null, campaignId, { ask_id: 'question', answer: '' }, f.deps), expected);
    assert.deepStrictEqual(f.calls, [{ route: `${base}/asks/question/answer`, options: post({ answer: '' }) }]);
  }
});

test('missing, blank, or unreadable credentials return login guidance without requests', async () => {
  for (const loadCredentials of [() => null, () => ({ token: '   ' }), () => { throw new Error('unreadable'); }]) {
    const result = await sendPersonAction(null, campaignId, {}, {
      loadCredentials,
      apiRequestJson: () => assert.fail('must not request without a token'),
    });
    assert.deepStrictEqual(result, { ok: false, status: 401, error: 'not logged in to Atris. run: atris login' });
  }
});
