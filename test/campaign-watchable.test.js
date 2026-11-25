'use strict';

// Campaigns a person can watch and talk to. Each test here is one line of the
// contract in atris/campaigns/cmp-watchable-campaigns/CONTRACT.md, and the
// campaign's judge looks for these exact titles.

const test = require('node:test');
const assert = require('node:assert/strict');

const { campaignCommand } = require('../commands/campaign');
const { createMemoryStore, getCampaign } = require('../lib/campaign-store');
const { cloudLink, syncCampaign } = require('../lib/campaign-sync');

// Runs one campaign command against a store and keeps what it printed.
async function command(store, args, deps = {}) {
  const logs = [];
  const errors = [];
  const saved = { log: console.log, error: console.error };
  console.log = (line) => logs.push(String(line));
  console.error = (line) => errors.push(String(line));
  try {
    const code = await campaignCommand(args, {
      store,
      actor: 'human:keshav',
      runJudge: () => ({ passed: false, exit: 1, summary: 'pass 0, fail 3', seconds: 0, reading: 0 }),
      ...deps,
    });
    return { code, out: logs.join('\n'), err: errors.join('\n') };
  } finally {
    console.log = saved.log;
    console.error = saved.error;
  }
}

// The cloud's own rule for pushed events (backend campaign_service.py): money
// is a number, above zero for a budget, and nothing is past a million.
function strictCloud() {
  const events = [];
  const bodies = [];
  const apiRequestJson = async (route, options = {}) => {
    if (options.method === 'POST') {
      bodies.push(options.body);
      for (const event of options.body.events) {
        const budget = event.data && event.data.budget;
        if (event.type === 'campaign_started' && (typeof budget !== 'number' || !(budget > 0) || budget > 1e6)) {
          return { ok: false, status: 400, data: { error: 'budget must be a number no bigger than 1,000,000' } };
        }
      }
      let accepted = 0;
      for (const event of options.body.events) {
        if (events.some((e) => e.id === event.id)) continue;
        events.push(event);
        accepted += 1;
      }
      return { ok: true, status: 200, data: { ok: true, accepted, duplicates: options.body.events.length - accepted, last_event_seq: events.length } };
    }
    const after = Number((/after=(\d+)/.exec(route) || [])[1]) || 0;
    return { ok: true, status: 200, data: { ok: true, events: events.slice(after), last_event_seq: events.length } };
  };
  return { events, bodies, deps: { apiRequestJson, loadCredentials: () => ({ token: 'test-token' }) } };
}

test('sync sends a campaign that has no budget', async () => {
  const store = createMemoryStore({ origin: 'laptop' });
  const cloud = strictCloud();
  const started = await command(store, ['start', 'Ship it with no limit', '--judge', 'npm test', '--id', 'cmp-no-budget'], { cloud: cloud.deps });
  assert.equal(started.code, 0, started.err);
  const local = store.read('cmp-no-budget').find((event) => event.type === 'campaign_started');

  // The verb a person types, then the library call underneath it.
  const synced = await command(store, ['sync', 'cmp-no-budget'], { cloud: cloud.deps });
  assert.equal(synced.code, 0, synced.err);
  assert.match(synced.out, /synced with the cloud: sent 2/);
  const again = await syncCampaign(store, 'cmp-no-budget', cloud.deps);
  assert.equal(again.ok, true, again.error);
  assert.equal(again.pushed, 0);

  // The cloud took the start with a budget it accepts, and nothing else changed.
  const sent = cloud.events.find((event) => event.type === 'campaign_started');
  assert.equal(typeof sent.data.budget, 'number');
  assert.ok(sent.data.budget > 0 && sent.data.budget <= 1e6, `budget sent was ${sent.data.budget}`);
  assert.equal(sent.id, local.id);
  assert.equal(sent.data.title, 'Ship it with no limit');
  assert.ok(cloudLink(store, 'cmp-no-budget'));

  // The copy here is untouched, and it still reads as a campaign with no limit.
  assert.deepEqual(store.read('cmp-no-budget').find((event) => event.type === 'campaign_started'), local);
  assert.doesNotMatch(synced.out, /^budget/m);

  // A computer that pulls this campaign from the cloud also sees no limit.
  const other = createMemoryStore({ origin: 'desktop' });
  const pulled = await command(other, ['sync', 'cmp-no-budget'], { cloud: cloud.deps });
  assert.equal(pulled.code, 0, pulled.err);
  assert.doesNotMatch(pulled.out, /^budget/m);
  assert.equal(getCampaign(other, 'cmp-no-budget').title, 'Ship it with no limit');

  // A real budget still goes up exactly as written.
  const paid = await command(store, ['start', 'Ship it for twenty', '--judge', 'npm test', '--budget', '20', '--id', 'cmp-twenty'], { cloud: cloud.deps });
  assert.equal(paid.code, 0, paid.err);
  const paidSync = await command(store, ['sync', 'cmp-twenty'], { cloud: cloud.deps });
  assert.equal(paidSync.code, 0, paidSync.err);
  assert.equal(cloud.events.find((event) => event.campaign_id === 'cmp-twenty' && event.type === 'campaign_started').data.budget, 20);
  assert.match(paidSync.out, /^budget/m);
});
