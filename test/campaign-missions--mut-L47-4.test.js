'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { checkCampaignStart } = require('../lib/campaign-missions');
const { createMemoryStore, getCampaign } = require('../lib/campaign-store');

test('a mission may reserve exactly the available campaign budget', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'campaign-exact-reserve-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createMemoryStore({
    origin: 'test',
    now: () => '2025-01-01T00:00:00.000Z',
  });
  store.append({
    campaign_id: 'cmp-exact',
    type: 'campaign_started',
    actor: 'builder',
    data: { title: 'Exact reserve', judge: 'exit 1', budget: 10 },
  });
  const campaign = getCampaign(store, 'cmp-exact');
  assert.equal(campaign.budget.available, 10);

  assert.deepEqual(
    checkCampaignStart(root, 'cmp-exact', { reserveUsd: 10 }, { store }),
    { ok: true, campaign, reserve: 10 },
  );
});
