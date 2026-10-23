'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { checkCampaignStart } = require('../lib/campaign-missions');
const { createMemoryStore } = require('../lib/campaign-store');

test('a mission owned by another campaign is refused with its existing owner', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'campaign-mission-owner-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createMemoryStore({ origin: 'ownership-test' });
  for (const campaignId of ['cmp-owner', 'cmp-target']) {
    store.append({
      campaign_id: campaignId,
      type: 'campaign_started',
      actor: 'builder',
      data: { title: campaignId, judge: 'exit 1', budget: 20 },
    });
  }
  store.append({
    campaign_id: 'cmp-owner',
    type: 'mission_started',
    actor: 'builder',
    data: { mission_id: 'mission-owned', member: 'builder', objective: 'finish work' },
  });

  assert.deepStrictEqual(
    checkCampaignStart(root, 'cmp-target', { missionId: 'mission-owned', reserveUsd: 1 }, { store }),
    { ok: false, error: 'mission mission-owned already belongs to campaign cmp-owner' },
  );
});
