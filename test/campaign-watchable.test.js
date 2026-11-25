'use strict';

// Campaigns a person can watch and talk to. Each test here is one line of the
// contract in atris/campaigns/cmp-watchable-campaigns/CONTRACT.md, and the
// campaign's judge looks for these exact titles.

const test = require('node:test');
const assert = require('node:assert/strict');

const { campaignCommand } = require('../commands/campaign');
const { createMemoryStore, getCampaign } = require('../lib/campaign-store');
const { cloudLink, syncCampaign } = require('../lib/campaign-sync');
const { chosenRunner } = require('../lib/campaign-loop');
const { recordCampaignMissionStarted, recordCampaignTick } = require('../lib/campaign-missions');

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

test('a campaign can name a lead member', async () => {
  const store = createMemoryStore({ origin: 'laptop' });

  // Named on the start: stored, shown, and the lead plans the work.
  const started = await command(store, ['start', 'Take investing live', '--judge', 'npm test', '--lead', 'investing-lead', '--id', 'cmp-led']);
  assert.equal(started.code, 0, started.err);
  assert.equal(store.read('cmp-led')[0].data.lead, 'investing-lead');
  let view = getCampaign(store, 'cmp-led');
  assert.equal(view.lead, 'investing-lead');
  assert.equal(view.owner, 'investing-lead');
  const shown = await command(store, ['show', 'cmp-led']);
  assert.match(shown.out, /^lead\s+investing-lead$/m);
  const asJson = await command(store, ['show', 'cmp-led', '--json']);
  assert.equal(JSON.parse(asJson.out).campaign.lead, 'investing-lead');

  // An owner named too keeps the planning; the lead still manages.
  await command(store, ['start', 'Two hats', '--judge', 'npm test', '--lead', 'chief', '--owner', 'planner', '--id', 'cmp-two']);
  view = getCampaign(store, 'cmp-two');
  assert.equal(view.lead, 'chief');
  assert.equal(view.owner, 'planner');

  // Named later on a campaign that began without one, then changed.
  await command(store, ['start', 'No lead yet', '--judge', 'npm test', '--id', 'cmp-later']);
  assert.equal(getCampaign(store, 'cmp-later').lead, undefined);
  const none = await command(store, ['lead', 'cmp-later']);
  assert.match(none.out, /has no lead yet/);
  const named = await command(store, ['lead', 'cmp-later', 'mission-lead']);
  assert.equal(named.code, 0, named.err);
  assert.match(named.out, /mission-lead now leads cmp-later/);
  assert.equal(getCampaign(store, 'cmp-later').lead, 'mission-lead');
  await command(store, ['lead', 'cmp-later', 'neon']);
  assert.equal(getCampaign(store, 'cmp-later').lead, 'neon');
  const who = await command(store, ['lead', 'cmp-later']);
  assert.match(who.out, /cmp-later is led by neon/);
  assert.match((await command(store, ['show', 'cmp-later'])).out, /^lead\s+neon$/m);

  // A member who is neither the owner nor the lead cannot take it over.
  const taken = await command(store, ['lead', 'cmp-later', 'stranger'], { actor: 'stranger' });
  assert.equal(taken.code, 2);
  assert.match(taken.err, /only the owner \(mission-lead\), the lead, or a person can name the lead/);
  assert.equal(getCampaign(store, 'cmp-later').lead, 'neon');
  // The lead itself can hand it on.
  assert.equal((await command(store, ['lead', 'cmp-later', 'mission-lead'], { actor: 'neon' })).code, 0);
  assert.equal(getCampaign(store, 'cmp-later').lead, 'mission-lead');
});

// A mission runner that starts and finishes every mission it is handed, the
// way atris mission start and run record them in the campaign.
function fakeMissions(store, campaignId) {
  const starts = [];
  const cli = async (args) => {
    const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : '');
    if (args[0] === 'mission' && args[1] === 'start') {
      const mission = { id: flag('--mission-id'), campaign_id: campaignId, owner: flag('--owner'), objective: args[2], runner: flag('--runner'), model: flag('--model') };
      starts.push({ runner: mission.runner, model: mission.model, owner: mission.owner });
      recordCampaignMissionStarted('/x', mission, 0, { store });
      return { code: 0, out: '{}', err: '' };
    }
    if (args[0] === 'mission' && args[1] === 'run') {
      const id = args[2];
      const member = getCampaign(store, campaignId).missions.find((m) => m.id === id).member;
      // Each tick says which engine did the work: the one named for the run, or the member's own.
      const named = starts[starts.length - 1].runner;
      recordCampaignTick('/x', { id, campaign_id: campaignId, owner: member }, { cost_usd: 0, engine: named === 'auto' ? 'codex' : named }, { store });
      store.append({ campaign_id: campaignId, type: 'mission_ended', actor: member, data: { mission_id: id, outcome: 'kept', cost_usd: 0 } });
    }
    return { code: 0, out: '', err: '' };
  };
  const ask = async () => ({ ok: true, engine: 'fake', text: JSON.stringify([{ objective: 'Write the first named test', member: 'builder', verify: 'npm test' }]) });
  return { starts, loopDeps: { cli, ask, skipReconcile: true } };
}

test('run can use a chosen engine like agy or fable', async () => {
  const runWith = async (id, runner) => {
    const store = createMemoryStore({ origin: 'laptop' });
    const started = await command(store, ['start', `Run on ${runner || 'its own engines'}`, '--judge', 'npm test', '--seat', 'builder', '--id', id]);
    assert.equal(started.code, 0, started.err);
    const missions = fakeMissions(store, id);
    const ran = await command(store, ['run', id, '--max-steps', '2', ...(runner ? ['--runner', runner] : [])], { loopDeps: missions.loopDeps });
    assert.equal(ran.code, 0, ran.err);
    return { store, starts: missions.starts, mission: getCampaign(store, id).missions[0], shown: (await command(store, ['show', id])).out };
  };

  // Neon's engine, by its own name and by its long one.
  const agy = await runWith('cmp-agy', 'agy');
  assert.deepEqual(agy.starts, [{ runner: 'agy', model: '', owner: 'builder' }]);
  assert.equal(agy.mission.engine, 'agy');
  assert.match(agy.shown, /builder · ran on agy · kept/);
  assert.equal((await runWith('cmp-antigravity', 'antigravity')).mission.engine, 'agy');

  // Fable, as its own engine and as claude running the fable model.
  const fable = await runWith('cmp-fable', 'fable');
  assert.deepEqual(fable.starts, [{ runner: 'fable', model: '', owner: 'builder' }]);
  assert.equal(fable.mission.engine, 'fable');
  const claudeFable = await runWith('cmp-claude-fable', 'claude fable');
  assert.deepEqual(claudeFable.starts, [{ runner: 'claude', model: 'fable', owner: 'builder' }]);
  assert.equal(claudeFable.mission.engine, 'claude');
  assert.equal(claudeFable.mission.model, 'fable');
  assert.match(claudeFable.shown, /builder · ran on claude fable · kept/);
  // The start event is where the engine is kept.
  const startEvent = claudeFable.store.read('cmp-claude-fable').find((event) => event.type === 'mission_started');
  assert.equal(startEvent.data.engine, 'claude');
  assert.equal(startEvent.data.model, 'fable');

  // With no engine named, each member runs on its own and the mission still says which one did the work.
  const own = await runWith('cmp-own', '');
  assert.deepEqual(own.starts, [{ runner: 'auto', model: '', owner: 'builder' }]);
  assert.equal(own.store.read('cmp-own').find((event) => event.type === 'mission_started').data.engine, undefined);
  assert.equal(own.mission.engine, 'codex');
  assert.match(own.shown, /builder · ran on codex · kept/);

  // The planner's engine is never mistaken for the worker's.
  const plan = own.store.read('cmp-own').find((event) => event.type === 'step' && event.data.kind === 'plan');
  assert.equal(plan.data.engine, 'fake');

  assert.deepEqual(chosenRunner('codex gpt-6.1-sol'), { runner: 'codex', model: 'gpt-6.1-sol' });
  assert.deepEqual(chosenRunner('auto'), { runner: 'auto', model: '' });
  // A name nobody knows goes through as written, so the mission start refuses it by name.
  assert.deepEqual(chosenRunner('no-such-engine'), { runner: 'no-such-engine', model: '' });
});
