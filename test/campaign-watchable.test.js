'use strict';

// Campaigns a person can watch and talk to. Each test here is one line of the
// contract in atris/campaigns/cmp-watchable-campaigns/CONTRACT.md, and the
// campaign's judge looks for these exact titles.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { campaignCommand, campaignFromChat } = require('../commands/campaign');
const { closeCampaignStores, createMemoryStore, getCampaign, listCampaigns, openCampaignStore } = require('../lib/campaign-store');
const feed = require('../lib/feed-core');
const room = require('../lib/feed-room');
const decisionFeed = require('../commands/decision-feed');
const { project } = require('./helpers/feed-project');
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

// ------------------------------------------------- the campaign's feed card

// A scratch project with a team, its own feed and its own campaign store.
function feedProject(t, members = ['mission-lead', 'builder']) {
  const ctx = project(t, members);
  const saved = process.env.ATRIS_CAMPAIGN_DB;
  process.env.ATRIS_CAMPAIGN_DB = path.join(ctx.dir, 'campaigns.db');
  ctx.env.ATRIS_CAMPAIGN_DB = process.env.ATRIS_CAMPAIGN_DB;
  ctx.agentEnv.ATRIS_CAMPAIGN_DB = process.env.ATRIS_CAMPAIGN_DB;
  ctx.store = openCampaignStore(ctx.root);
  t.after(() => {
    closeCampaignStores();
    if (saved === undefined) delete process.env.ATRIS_CAMPAIGN_DB; else process.env.ATRIS_CAMPAIGN_DB = saved;
  });
  // The judge reads whatever the test sets next.
  ctx.reading = { passed: false, exit: 1, summary: 'pass 0, fail 21', seconds: 0, reading: 0 };
  ctx.campaign = (args, deps = {}) => command(ctx.store, args, { runJudge: () => ctx.reading, ...deps });
  ctx.campaignCards = () => feed.listCards(ctx.root, { filter: 'all', limit: 100, env: ctx.env }).cards
    .concat(feed.listCards(ctx.root, { filter: 'working', limit: 100, env: ctx.env }).cards)
    .filter((card) => card.source.type === 'campaign')
    .filter((card, index, all) => all.findIndex((other) => other.id === card.id) === index);
  return ctx;
}

// What `atris feed <args>` prints.
async function feedCommand(ctx, args, env = ctx.env) {
  const lines = [];
  const saved = { log: console.log, error: console.error };
  console.log = (line) => lines.push(String(line));
  console.error = (line) => lines.push(String(line));
  try {
    const code = await decisionFeed.run(args, { cwd: ctx.root, env, deps: ctx.deps, write: (text) => lines.push(String(text)) });
    return { code, out: lines.join('\n') };
  } finally {
    console.log = saved.log;
    console.error = saved.error;
  }
}

test('a campaign keeps one feed card with its score', async (t) => {
  const ctx = feedProject(t);
  assert.deepEqual(ctx.campaignCards(), [], 'no campaign, no card');

  const started = await ctx.campaign(['start', 'Take investing live', '--judge', 'npm test', '--lead', 'mission-lead', '--id', 'cmp-invest']);
  assert.equal(started.code, 0, started.err);
  let cards = ctx.campaignCards();
  assert.equal(cards.length, 1, 'starting a campaign puts one card on the feed');
  const first = cards[0];
  assert.equal(first.id, 'campaign:cmp-invest');
  assert.equal(first.title, 'Take investing live');
  assert.equal(first.author.name, 'mission-lead');
  assert.deepEqual(first.campaign.score, { passed: 0, total: 21, done: false, text: '0 of 21' });
  assert.match(first.body, /^Score 0 of 21 · resting · led by mission-lead$/);

  // Each judge reading changes that same card.
  ctx.reading = { passed: false, exit: 1, summary: 'pass 7, fail 14', seconds: 0, reading: 7 / 21 };
  assert.equal((await ctx.campaign(['judge', 'cmp-invest'])).code, 1);
  cards = ctx.campaignCards();
  assert.equal(cards.length, 1, 'a second reading never makes a second card');
  assert.equal(cards[0].id, first.id);
  assert.equal(cards[0].campaign.score.text, '7 of 21');
  assert.match(cards[0].body, /^Score 7 of 21 · /);
  assert.equal(cards[0].created_at, first.created_at, 'the card is as old as the campaign');
  assert.equal(feed.readCard(ctx.root, first.id, { env: ctx.env }).campaign.score.text, '7 of 21');

  // The list a person reads in the terminal shows it once, with the score.
  const listed = await feedCommand(ctx, ['cards']);
  assert.equal(listed.code, 0, listed.out);
  assert.equal(listed.out.match(/Take investing live/g).length, 1);
  assert.match(listed.out, /campaign\s+Take investing live\n\s+Score 7 of 21 · resting · led by mission-lead/);

  // While missions run the card sits with the work in progress, still once.
  ctx.store.append({ campaign_id: 'cmp-invest', type: 'mission_started', actor: 'builder', data: { mission_id: 'm-1', member: 'builder', objective: 'Wire the broker' } });
  const moving = feed.listCards(ctx.root, { filter: 'working', env: ctx.env });
  assert.deepEqual(moving.cards.map((card) => card.id), [first.id]);
  assert.equal(moving.counts.working, 1);
  assert.equal(ctx.campaignCards().length, 1);
  assert.match(ctx.campaignCards()[0].body, /^Score 7 of 21 · working now · /);
  ctx.store.append({ campaign_id: 'cmp-invest', type: 'mission_ended', actor: 'builder', data: { mission_id: 'm-1', outcome: 'kept', cost_usd: 0 } });

  // A passing judge finishes the campaign on the same card.
  ctx.reading = { passed: true, exit: 0, summary: 'pass 21, fail 0', seconds: 0, reading: 1 };
  assert.equal((await ctx.campaign(['judge', 'cmp-invest'])).code, 0);
  cards = ctx.campaignCards();
  assert.equal(cards.length, 1);
  assert.equal(cards[0].id, first.id);
  assert.equal(cards[0].state, 'done');
  assert.deepEqual(cards[0].campaign.score, { passed: 21, total: 21, done: true, text: '21 of 21' });
  assert.match(cards[0].body, /^Score 21 of 21 · done · /);

  // A second campaign gets its own card; the first still has exactly one.
  ctx.reading = { passed: false, exit: 1, summary: 'still red', seconds: 0 };
  await ctx.campaign(['start', 'Ship the scoreboard', '--judge', 'npm test', '--id', 'cmp-board']);
  cards = ctx.campaignCards();
  assert.deepEqual(cards.map((card) => card.id).sort(), ['campaign:cmp-board', 'campaign:cmp-invest']);
  assert.equal(cards.find((card) => card.id === 'campaign:cmp-board').campaign.score.text, 'not passing yet');

  // Nothing about a campaign card can be approved, passed or dismissed away.
  assert.equal(cards[0].can_decide, false);
  assert.throws(() => feed.decide(ctx.root, first.id, 'approve', { env: ctx.env }), /nothing to decide on a campaign card/);
  assert.deepEqual(feed.passCards(ctx.root, [first.id], { env: ctx.env }).skipped, [first.id]);
  assert.equal(feed.dismissCards(ctx.root, [first.id], { env: ctx.env }).skipped[0].id, first.id);
  assert.equal(ctx.campaignCards().length, 2);
});

test('the campaign card lists each step and who did it', async (t) => {
  const ctx = feedProject(t);
  await ctx.campaign(['start', 'Take investing live', '--judge', 'npm test', '--lead', 'mission-lead', '--seat', 'builder', '--id', 'cmp-steps'], { actor: 'mission-lead' });
  const missions = fakeMissions(ctx.store, 'cmp-steps');
  const ran = await ctx.campaign(['run', 'cmp-steps', '--max-steps', '2', '--runner', 'agy'], { actor: 'mission-lead', loopDeps: missions.loopDeps });
  assert.equal(ran.code, 0, ran.err);
  ctx.reading = { passed: false, exit: 1, summary: 'pass 3, fail 18', seconds: 0, reading: 3 / 21 };
  await ctx.campaign(['judge', 'cmp-steps'], { actor: 'mission-lead' });
  await ctx.campaign(['ask', 'cmp-steps', 'May I place a real order?'], { actor: 'builder' });

  const card = ctx.campaignCards().find((item) => item.id === 'campaign:cmp-steps');
  const steps = card.steps;
  const line = (step) => `${step.kind} | ${step.who}${step.engine ? ` on ${step.engine}` : ''} | ${step.text}`;
  assert.deepEqual(steps.map(line), [
    'start | mission-lead | started the campaign',
    'judge | judge | judge read 0 of 21',
    'mission | builder | planned: Write the first named test',
    'plan | mission-lead on fake | planned the next missions',
    'mission | builder on agy | started: Write the first named test',
    'mission | builder on agy | worked on: Write the first named test',
    'mission | builder | finished: Write the first named test (kept)',
    'judge | judge | judge read 3 of 21',
    'ask | builder | asked you: May I place a real order?',
  ]);
  // Newest last, and every step says when and who.
  const times = steps.map((step) => Date.parse(step.at));
  assert.deepEqual(times, times.slice().sort((a, b) => a - b));
  for (const step of steps) {
    assert.ok(step.who, `a step with nobody behind it: ${step.text}`);
    assert.ok(['member', 'person', 'system'].includes(step.who_type));
  }
  assert.equal(steps.filter((step) => step.kind === 'mission').every((step) => step.mission_id), true);
  assert.equal(card.steps_total, steps.length);
  assert.deepEqual(card.progress, { text: 'builder: asked you: May I place a real order?', at: steps[steps.length - 1].at });
  assert.equal(card.story[card.story.length - 1], 'builder: asked you: May I place a real order?');

  // A person's own step is theirs by name, and it lands at the end.
  await ctx.campaign(['pause', 'cmp-steps']);
  const after = ctx.campaignCards().find((item) => item.id === 'campaign:cmp-steps').steps;
  assert.equal(after.length, steps.length + 1);
  assert.equal(line(after[after.length - 1]), 'state | keshav | paused the campaign');
  assert.equal(after[after.length - 1].who_type, 'person');

  // A session that never named its member reads as a team member, never as a machine word.
  await ctx.campaign(['resume', 'cmp-steps'], { actor: 'agent' });
  const unnamed = ctx.campaignCards().find((item) => item.id === 'campaign:cmp-steps').steps.pop();
  assert.equal(line(unnamed), 'state | a team member | resumed the campaign');
  await ctx.campaign(['pause', 'cmp-steps']);

  // The terminal list shows the newest steps under the card, newest at the bottom.
  const listed = (await feedCommand(ctx, ['cards'])).out;
  assert.match(listed, /builder: asked you: May I place a real order\?\n\s+keshav: paused the campaign\n\s+a team member: resumed the campaign/);
  assert.ok(listed.indexOf('judge: judge read 3 of 21') < listed.indexOf('keshav: paused the campaign'));
});

test("an ask becomes a question card and a person's answer closes it", async (t) => {
  const ctx = feedProject(t);
  await ctx.campaign(['start', 'Take investing live', '--judge', 'npm test', '--lead', 'mission-lead', '--id', 'cmp-ask']);
  const asked = await ctx.campaign(['ask', 'cmp-ask', 'May I place a real order for ten dollars?', '--json'], { actor: 'mission-lead' });
  const askId = JSON.parse(asked.out).campaign.asks[0].id;
  const cardId = `campaign:cmp-ask:ask:${askId}`;

  // The ask shows as a question waiting on the person, beside the campaign's own card.
  let cards = ctx.campaignCards();
  assert.deepEqual(cards.map((card) => card.id).sort(), ['campaign:cmp-ask', cardId].sort());
  const question = cards.find((card) => card.id === cardId);
  assert.equal(question.kind, 'question');
  assert.equal(question.title, 'May I place a real order for ten dollars?');
  assert.equal(question.author.name, 'mission-lead');
  assert.equal(question.needs_decision, true);
  assert.equal(feed.listCards(ctx.root, { env: ctx.env }).counts.needs_decision, 1);
  assert.deepEqual(cards.find((card) => card.id === 'campaign:cmp-ask').campaign.open_asks, [cardId]);
  assert.match(cards.find((card) => card.id === 'campaign:cmp-ask').body, /waiting on your answer/);
  assert.match((await feedCommand(ctx, ['cards'])).out, /answer\s+May I place a real order for ten dollars\?/);

  // A team member's session cannot answer it: not on the feed, not with campaign answer.
  assert.throws(() => feed.decide(ctx.root, cardId, 'approve', { note: 'yes', env: ctx.agentEnv }), /Only a person can answer a campaign question/);
  await assert.rejects(feed.talk(ctx.root, cardId, 'yes, go ahead', { env: ctx.agentEnv, deps: ctx.deps }), /Only a person can answer a campaign question/);
  await assert.rejects(feed.talk(ctx.root, cardId, 'yes, go ahead', { as: 'mission-lead', env: ctx.env, deps: ctx.deps }), /Only a person can answer a campaign question/);
  const byMember = await ctx.campaign(['answer', 'cmp-ask', askId, 'yes'], { actor: 'mission-lead' });
  assert.match(byMember.out, /not closed: only a person can answer/);
  assert.equal(getCampaign(ctx.store, 'cmp-ask').asks.length, 1);
  assert.equal(ctx.campaignCards().some((card) => card.id === cardId), true, 'the question is still on the feed');

  // A question takes words: a bare yes and a dismiss are both refused.
  assert.throws(() => feed.decide(ctx.root, cardId, 'approve', { env: ctx.env }), /takes words/);
  assert.throws(() => feed.decide(ctx.root, cardId, 'dismiss', { env: ctx.env }), /stays until you answer it/);
  assert.equal(getCampaign(ctx.store, 'cmp-ask').asks.length, 1);

  // The person answers on the feed, and the ask closes.
  const decided = await feedCommand(ctx, ['decide', cardId, 'approve', '--note', 'Yes, ten dollars and no more.']);
  assert.equal(decided.code, 0, decided.out);
  assert.match(decided.out, /answered\. the campaign has your answer: Yes, ten dollars and no more\./);
  let view = getCampaign(ctx.store, 'cmp-ask');
  assert.deepEqual(view.asks, []);
  assert.notEqual(view.state, 'needs_you');
  const answer = ctx.store.read('cmp-ask').find((event) => event.type === 'ask_answered' && event.actor.startsWith('human:'));
  assert.deepEqual(answer.data, { ask_id: askId, answer: 'Yes, ten dollars and no more.' });
  assert.equal(answer.actor, 'human:owner');
  cards = ctx.campaignCards();
  assert.deepEqual(cards.map((card) => card.id), ['campaign:cmp-ask'], 'the question card is gone once answered');
  assert.deepEqual(cards[0].campaign.open_asks, []);
  assert.equal(cards[0].steps[cards[0].steps.length - 1].text, 'answered: Yes, ten dollars and no more.');
  assert.equal(feed.listCards(ctx.root, { env: ctx.env }).counts.needs_decision, 0);
  assert.throws(() => feed.readCard(ctx.root, cardId, { env: ctx.env }), /already answered/);

  // Words typed on the question card are an answer too.
  const second = JSON.parse((await ctx.campaign(['ask', 'cmp-ask', 'Which broker?', '--json'], { actor: 'mission-lead' })).out).campaign.asks[0].id;
  const talked = await feedCommand(ctx, ['talk', `campaign:cmp-ask:ask:${second}`, 'Use the paper account first.']);
  assert.equal(talked.code, 0, talked.out);
  assert.match(talked.out, /answered\. the campaign has your answer: Use the paper account first\./);
  assert.deepEqual(getCampaign(ctx.store, 'cmp-ask').asks, []);

  // A comment is how a screen answers a question card. A team member's comment leaves it open; the person's closes it.
  const fourth = JSON.parse((await ctx.campaign(['ask', 'cmp-ask', 'Cap each order at ten dollars?', '--json'], { actor: 'mission-lead' })).out).campaign.asks[0].id;
  const fourthCard = `campaign:cmp-ask:ask:${fourth}`;
  room.reply(ctx.root, fourthCard, 'I think ten is right.', { as: 'builder', kind: 'agree', env: ctx.agentEnv, deps: ctx.deps });
  assert.equal(getCampaign(ctx.store, 'cmp-ask').asks.length, 1);
  const commented = room.reply(ctx.root, fourthCard, 'Yes, cap it at ten.', { env: ctx.env, deps: ctx.deps });
  assert.equal(commented.answered, true);
  assert.equal(commented.card.id, 'campaign:cmp-ask');
  assert.deepEqual(getCampaign(ctx.store, 'cmp-ask').asks, []);
  assert.equal(ctx.store.read('cmp-ask').filter((event) => event.type === 'ask_answered').pop().data.answer, 'Yes, cap it at ten.');

  // And campaign answer from a person's own session closes one and takes its card away.
  const third = JSON.parse((await ctx.campaign(['ask', 'cmp-ask', 'Go live Monday?', '--json'], { actor: 'mission-lead' })).out).campaign.asks[0].id;
  assert.equal(ctx.campaignCards().length, 2);
  const byPerson = await ctx.campaign(['answer', 'cmp-ask', third, 'Yes, Monday.']);
  assert.match(byPerson.out, new RegExp(`answered ${third}: Yes, Monday\\.`));
  assert.deepEqual(ctx.campaignCards().map((card) => card.id), ['campaign:cmp-ask']);
});

test('talking on the campaign card reaches the lead', async (t) => {
  const ctx = feedProject(t, ['investing-lead', 'builder']);
  await ctx.campaign(['start', 'Take investing live', '--judge', 'npm test', '--lead', 'investing-lead', '--id', 'cmp-talk']);
  const cardId = 'campaign:cmp-talk';
  ctx.deps.answer = () => 'We are at 0 of 21. I will plan around the paper account first.';

  const talked = await feedCommand(ctx, ['talk', cardId, 'Stay on the paper account until I say so.']);
  assert.equal(talked.code, 0, talked.out);
  assert.equal(talked.out, 'investing-lead: We are at 0 of 21. I will plan around the paper account first.');

  // The lead is the one who answered, on its own engine, knowing the campaign and the words.
  assert.equal(ctx.turns.length, 1);
  assert.equal(ctx.turns[0].engine, 'codex');
  assert.match(ctx.turns[0].prompt, /^You are investing-lead, the member who leads this campaign/);
  assert.match(ctx.turns[0].prompt, /Goal: Take investing live/);
  assert.match(ctx.turns[0].prompt, /Score: 0 of 21\./);
  assert.match(ctx.turns[0].prompt, /Owner: Stay on the paper account until I say so\./);

  // Both sides are saved on the campaign, in order.
  const said = feed.listMessages(ctx.root, cardId, { env: ctx.env }).messages;
  assert.deepEqual(said.map((m) => [m.from.type, m.from.name, m.text]), [
    ['user', 'You', 'Stay on the paper account until I say so.'],
    ['agent', 'investing-lead', 'We are at 0 of 21. I will plan around the paper account first.'],
  ]);
  const kept = JSON.parse(ctx.store.getMeta('campaign_talk:cmp-talk'));
  assert.deepEqual(kept.map((entry) => entry.from), ['user:owner', 'agent:investing-lead']);
  assert.equal(kept[1].engine, 'codex');
  const card = feed.readCard(ctx.root, cardId, { env: ctx.env });
  assert.equal(card.message_count, 2);
  assert.equal(card.last_message_at, kept[1].at);
  assert.match((await feedCommand(ctx, ['messages', cardId])).out, /You: Stay on the paper account[^\n]*\ninvesting-lead: We are at 0 of 21/);

  // What the person said steers the next plan.
  const prompts = [];
  const plan = { skipReconcile: true, cli: async () => ({ code: 0, out: '', err: '' }), ask: async (root, view, prompt) => { prompts.push(prompt); return { ok: true, engine: 'fake', text: '[]' }; } };
  await ctx.campaign(['propose', 'cmp-talk'], { loopDeps: plan });
  assert.match(prompts[0], /The person said this on the campaign card[^\n]*\n- Stay on the paper account until I say so\./);

  // A second message carries the conversation so far to the lead.
  ctx.deps.answer = () => 'Understood. Nothing real is placed until you say so.';
  const again = await feed.talk(ctx.root, cardId, 'Good. Tell me before anything real.', { env: ctx.env, deps: ctx.deps });
  assert.equal(again.lead, 'investing-lead');
  assert.equal(again.reply.text, 'Understood. Nothing real is placed until you say so.');
  assert.match(ctx.turns[1].prompt, /investing-lead: We are at 0 of 21[^\n]*\nOwner: Good\. Tell me before anything real\./);
  assert.equal(feed.listMessages(ctx.root, cardId, { env: ctx.env }).messages.length, 4);

  // A team member's session cannot speak as the owner; the lead can write by hand, and only the lead.
  await assert.rejects(feed.talk(ctx.root, cardId, 'ship it', { env: ctx.agentEnv, deps: ctx.deps }), /Only a person can talk to the lead as the owner/);
  await assert.rejects(feed.talk(ctx.root, cardId, 'I will take it', { as: 'builder', env: ctx.agentEnv, deps: ctx.deps }), /Only investing-lead, who leads this campaign/);
  const byHand = await feed.talk(ctx.root, cardId, 'The broker is wired to paper.', { as: 'investing-lead', env: ctx.agentEnv, deps: ctx.deps });
  assert.equal(byHand.message.from.name, 'investing-lead');
  assert.equal(ctx.turns.length, 2, 'writing by hand asks no engine');
  assert.equal(feed.listMessages(ctx.root, cardId, { env: ctx.env }).messages.length, 5);

  // A password in the message is refused before anything is saved or sent.
  // Built here so no key-shaped text sits in this file.
  const keyShaped = ['sk', 'live', 'abcdefghijklmnopqrstuvwx'].join('_');
  await assert.rejects(feed.talk(ctx.root, cardId, `use ${keyShaped} for the broker`, { env: ctx.env, deps: ctx.deps }));
  assert.equal(feed.listMessages(ctx.root, cardId, { env: ctx.env }).messages.length, 5);

  // A lead that is switched off does not answer, the person is told, and the words are still kept.
  require('../lib/member-switches').setMemberAwake('investing-lead', false, ctx.root);
  const off = await feed.talk(ctx.root, cardId, 'Are you there?', { env: ctx.env, deps: ctx.deps });
  assert.equal(off.reply, null);
  assert.match(off.reply_skipped, /investing-lead is off/);
  assert.equal(ctx.turns.length, 2);
  assert.equal(feed.listMessages(ctx.root, cardId, { env: ctx.env }).messages.length, 6);

  // When the lead changes, the new lead answers.
  await ctx.campaign(['lead', 'cmp-talk', 'builder']);
  ctx.deps.answer = () => 'I lead this now.';
  const handed = await feed.talk(ctx.root, cardId, 'Who has this?', { env: ctx.env, deps: ctx.deps });
  assert.equal(handed.lead, 'builder');
  assert.match(ctx.turns[2].prompt, /^You are builder, the member who leads this campaign/);
});

// ------------------------------------------- a lead starts one from chat

test('a lead can start a campaign from a goal sentence in chat', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'campaign-chat-'));
  const before = process.cwd();
  t.after(() => {
    process.chdir(before);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  for (const member of ['investing-lead', 'builder']) {
    fs.mkdirSync(path.join(dir, 'atris', 'team', member), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'team', member, 'MEMBER.md'), `# ${member}\n`);
  }
  process.chdir(dir);

  const store = createMemoryStore({ origin: 'laptop' });
  const asked = [];
  const judgeScript = 'echo "ℹ pass 0"\necho "ℹ fail 3"\nexit 1';
  let draft = JSON.stringify({ title: 'Paper account trades by Friday', judge_script: judgeScript, why: 'counts the three trades the paper account must place', seats: ['builder'] });
  const loopDeps = { ask: async (root, view, prompt) => { asked.push({ owner: view.owner, prompt }); return { ok: true, engine: 'fake', text: draft }; } };
  const chat = async (member, words) => {
    const lines = [];
    const saved = { log: console.log, error: console.error };
    console.log = (line) => lines.push(String(line));
    console.error = (line) => lines.push(String(line));
    try {
      // The real judge runs here: the drafted script must truly fail today.
      const result = await campaignFromChat(member, words, { store, loopDeps });
      return { result, out: lines.join('\n') };
    } finally {
      console.log = saved.log;
      console.error = saved.error;
    }
  };

  // Ordinary chat starts nothing.
  assert.equal((await chat('investing-lead', 'How is the paper account doing today?')).result, null);
  assert.equal((await chat('investing-lead', 'I read about a campaign to plant trees')).result, null);
  assert.equal(listCampaigns(store).length, 0);
  assert.equal(asked.length, 0);

  // A goal sentence in chat: the lead drafts the judge and starts the campaign as its lead.
  const { result, out } = await chat('investing-lead', 'Start a campaign to get the paper account placing three trades by Friday.');
  assert.equal(result.code, 0, out);
  assert.equal(result.goal, 'get the paper account placing three trades by Friday');
  assert.equal(asked.length, 1);
  assert.equal(asked[0].owner, 'investing-lead', 'the lead drafts the judge on its own engine');
  assert.match(asked[0].prompt, /Goal: get the paper account placing three trades by Friday/);

  const views = listCampaigns(store);
  assert.equal(views.length, 1);
  const view = views[0];
  assert.equal(view.id, result.id);
  assert.equal(view.title, 'Paper account trades by Friday');
  assert.equal(view.lead, 'investing-lead');
  assert.equal(view.owner, 'investing-lead');
  assert.equal(view.created_from, 'atris campaign start by investing-lead');
  assert.deepEqual(view.seats.map((seat) => seat.member), ['builder']);

  // The judge is a real script in the project, and it fails today.
  assert.equal(view.judge, `sh atris/campaigns/${view.id}/judge.sh`);
  assert.match(fs.readFileSync(path.join(dir, 'atris', 'campaigns', view.id, 'judge.sh'), 'utf8'), /ℹ fail 3/);
  assert.equal(view.last_judge.passed, false);
  assert.equal(view.answer.text, 'pass 0, fail 3');
  assert.notEqual(view.state, 'done');
  assert.equal(view.missions.length, 0, 'starting from chat runs no work yet');

  // The chat says who leads it and how to watch and talk.
  assert.match(out, /investing-lead leads it\. Watch it: atris feed cards/);
  assert.match(out, new RegExp(`atris feed talk campaign:${view.id} `));

  // The other ways of saying it, and another member leading its own.
  for (const words of ['campaign: every screen has a dark mode', 'please run a campaign for faster first paint', 'Can you kick off a new campaign so that the report sends itself']) {
    draft = JSON.stringify({ title: words.slice(-24), judge_script: judgeScript, why: 'not met yet' });
    const next = await chat('builder', words);
    assert.equal(next.result.code, 0, next.out);
    assert.equal(getCampaign(store, next.result.id).lead, 'builder');
  }
  assert.equal(listCampaigns(store).length, 4);

  // A judge that already passes today starts nothing, and the lead says why.
  draft = JSON.stringify({ title: 'Already true', judge_script: 'echo "ℹ pass 1"\necho "ℹ fail 0"\nexit 0', why: 'nothing' });
  const refused = await chat('investing-lead', 'start a campaign to keep the lights on');
  assert.equal(refused.result.code, 1);
  assert.equal(refused.result.id, null);
  assert.match(refused.out, /already passes/);
  assert.equal(listCampaigns(store).length, 4);

  // The same path as one command, for a member working from a terminal.
  draft = JSON.stringify({ title: 'Statements reconcile nightly', judge_script: judgeScript, why: 'not met yet' });
  const typed = await command(store, ['new', 'statements reconcile every night', '--lead', 'investing-lead', '--yes', '--json'], { actor: 'investing-lead', loopDeps, runJudge: undefined });
  assert.equal(typed.code, 0, typed.err);
  const made = JSON.parse(typed.out.split('\n').pop());
  assert.equal(made.campaign.lead, 'investing-lead');
  assert.equal(made.draft.lead, 'investing-lead');
});
