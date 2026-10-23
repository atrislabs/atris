'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { syncCampaign } = require('../lib/campaign-sync');

function createTestStore(campaignId) {
  const meta = new Map();
  const ingested = [];
  const localEvent = { id: 'evt-local-1', origin: 'laptop', seq: 1 };

  const store = {
    getMeta: (key) => meta.get(key) || JSON.stringify({
      pushed: 1,
      last_seq: 0,
      link: { url: `https://api.atris.ai/api/campaigns/${campaignId}`, linked_at: '2026-10-23T00:00:00.000Z' },
    }),
    setMeta: (key, value) => { meta.set(key, String(value)); },
    read: (id) => (id === campaignId ? [localEvent] : []),
    ingest: (event) => {
      ingested.push(event);
      return true;
    },
  };

  return { store, ingested };
}

test('pull ignores incoming events belonging to another campaign', async () => {
  const { store, ingested } = createTestStore('cmp-target');

  const result = await syncCampaign(store, 'cmp-target', {
    loadCredentials: () => ({ token: 'test-token' }),
    now: () => '2026-10-23T00:00:00.000Z',
    apiRequestJson: async (path, options) => {
      if (options.method === 'GET') {
        return {
          ok: true,
          data: {
            events: [
              { id: 'evt-foreign-1', campaign_id: 'cmp-other', origin: 'cloud', seq: 1 },
            ],
            last_event_seq: 1,
          },
        };
      }
      return { ok: true, data: { accepted: 0 } };
    },
  });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.pulled, 0);
  assert.strictEqual(ingested.length, 0);
});

test('pull ignores null or falsy incoming event entries without throwing', async () => {
  const { store, ingested } = createTestStore('cmp-target');

  const result = await syncCampaign(store, 'cmp-target', {
    loadCredentials: () => ({ token: 'test-token' }),
    now: () => '2026-10-23T00:00:00.000Z',
    apiRequestJson: async (path, options) => {
      if (options.method === 'GET') {
        return {
          ok: true,
          data: {
            events: [null],
            last_event_seq: 1,
          },
        };
      }
      return { ok: true, data: { accepted: 0 } };
    },
  });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.pulled, 0);
  assert.strictEqual(ingested.length, 0);
});
