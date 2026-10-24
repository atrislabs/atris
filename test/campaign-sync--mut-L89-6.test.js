'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { syncCampaign } = require('../lib/campaign-sync');

test('pullWholeCampaign ignores events for other campaigns during initial sync', async () => {
  const campaignId = 'cmp-target';
  const meta = new Map();
  const events = [];
  const store = {
    getMeta: (key) => meta.get(key) || null,
    setMeta: (key, value) => meta.set(key, value),
    read: (id) => events.filter((e) => !id || e.campaign_id === id),
    ingest: (event) => {
      if (events.some((e) => e.id === event.id)) return false;
      events.push(event);
      return true;
    },
  };

  const matchingEvent = {
    id: 'evt-matching',
    campaign_id: campaignId,
    type: 'campaign_started',
    origin: 'cloud',
    seq: 1,
    at: '2025-01-01T00:00:00.000Z',
    actor: 'user',
    data: { title: 'Target', judge: 'test', budget: 10 },
  };
  const foreignEvent = {
    id: 'evt-foreign',
    campaign_id: 'cmp-other',
    type: 'paused',
    origin: 'cloud',
    seq: 2,
    at: '2025-01-01T00:00:00.000Z',
    actor: 'user',
    data: {},
  };

  let requests = 0;
  const deps = {
    loadCredentials: () => ({ token: 'test-token' }),
    apiRequestJson: async () => {
      requests += 1;
      if (requests === 1) {
        return {
          ok: true,
          data: {
            events: [matchingEvent, foreignEvent],
            last_event_seq: 2,
          },
        };
      }
      return { ok: true, data: { events: [], last_event_seq: 2 } };
    },
  };

  const result = await syncCampaign(store, campaignId, deps);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.first_pull, true);
  assert.strictEqual(result.pulled, 1);
  assert.deepStrictEqual(events.map((e) => e.id), [matchingEvent.id]);
});
