'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMemoryStore, createSqliteStore } = require('../lib/campaign-store');
const { validateEvent } = require('../lib/campaign-schema');
const { summarizeStoreRsi, summarizeTrace } = require('../lib/campaign-rsi');

function fixture(betaFinish = 20) {
  function campaign(name, created, jobs) {
    const events = [];
    const add = (type, minute, data, actor = 'worker') => {
      const seq = events.length + 1;
      events.push({ id: `${name}-${seq}`, campaign_id: `cmp-order-${name}`,
        origin: `order-${name}`, seq, at: `2026-10-16T10:${String(minute).padStart(2, '0')}:00Z`,
        type, actor, data });
    };
    add('campaign_started', created, { title: name, owner: 'owner', seats: ['worker'],
      judge: 'false', budget: 10, standing: true }, 'owner');
    add('judge_ran', created + 2, { passed: false, reading: 0.1 }, 'judge');
    for (const job of jobs) {
      const mission_id = `m-${name}-${job.outcome}`;
      add('mission_started', job.finish - 5, { mission_id, member: 'worker' });
      add('step', job.finish - 4, { mission_id, cost_usd: 0 });
      add('mission_ended', job.finish, { mission_id, outcome: job.outcome, cost_usd: 0 });
      add('judge_ran', job.finish + 1, { passed: false, reading: job.reading }, 'judge');
    }
    return events;
  }
  return [...campaign('alpha', 0, [
    { finish: 10, outcome: 'failed', reading: 0.1 },
    { finish: 30, outcome: 'kept', reading: 0.2 },
  ]), ...campaign('beta', 1, [{ finish: betaFinish, outcome: 'failed', reading: 0.1 }])];
}

function swapCreation(events) {
  const result = structuredClone(events);
  const starts = result.filter(event => event.type === 'campaign_started');
  [starts[0].at, starts[1].at] = [starts[1].at, starts[0].at];
  return result;
}

function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

function summaries(t, inputs) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'campaign-member-order-'));
  const databases = [];
  t.after(() => {
    for (const store of databases) store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const before = JSON.stringify(inputs);
  freeze(inputs);
  const run = kind => inputs.map((events, i) => {
    const store = kind === 'memory' ? createMemoryStore({ origin: 'reader' })
      : createSqliteStore(path.join(root, `${i}.db`), { origin: 'reader' });
    if (kind === 'sqlite') databases.push(store);
    for (const event of events) {
      assert.equal(validateEvent(event).ok, true, event.id);
      assert.equal(store.ingest(event), true);
    }
    const ids = store.campaignIds();
    const stored = ids.map(id => store.read(id));
    const result = summarizeStoreRsi(store);
    assert.deepEqual(ids.map(id => store.read(id)), stored, 'summarizing cannot rewrite stored events');
    assert.deepEqual(result.campaigns, ids.map(id => summarizeTrace(events.filter(event => event.campaign_id === id))));
    assert.deepEqual(result.missions, result.campaigns.flatMap(campaign => campaign.missions), 'public mission order remains campaign order');
    return result;
  });
  const memory = run('memory');
  assert.deepEqual(run('sqlite'), memory, 'both actual storage adapters produce the same complete result');
  assert.equal(JSON.stringify(inputs), before, 'caller events and creation timestamps remain unchanged');
  return memory;
}

function assertMember(result, repeats, overall) {
  assert.equal(result.members.length, 1);
  const worker = result.members[0];
  assert.equal(worker.repeat_failures, repeats);
  assert.equal(worker.overall, overall);
  assert.equal(worker.missions, 3);
  assert.equal(worker.kept, 1);
  assert.equal(worker.failed, 2);
  assert.equal(worker.reward, 0.1);
  assert.equal(worker.cost_usd, 0);
  assert.equal(result.total_reward, 0.1);
  assert.equal(result.total_spent_usd, 0);
}

test('global member learning follows completed work rather than campaign creation order', t => {
  const events = fixture();
  assert.equal(events.length, 16);
  const swapped = swapCreation(events);
  assert.deepEqual(swapped.filter((event, i) => JSON.stringify(event) !== JSON.stringify(events[i])).map(event => event.type),
    ['campaign_started', 'campaign_started']);
  const results = summaries(t, [events, swapped]);
  for (const result of results) assertMember(result, 1, 72);
  assert.deepEqual(results[0].members, results[1].members);
  assert.deepEqual(results[0].missions.map(mission => mission.mission_id), ['m-alpha-failed', 'm-alpha-kept', 'm-beta-failed']);
  assert.deepEqual(results[1].missions.map(mission => mission.mission_id), ['m-beta-failed', 'm-alpha-failed', 'm-alpha-kept']);
  for (const campaign of results[0].campaigns) {
    assert.deepEqual(campaign, results[1].campaigns.find(other => other.campaign_id === campaign.campaign_id));
  }
});

test('a kept result between two misses breaks the global failure streak', t => {
  const events = fixture(40);
  for (const result of summaries(t, [events, swapCreation(events)])) assertMember(result, 0, 74);
});

test('completion instants honor RFC3339 offsets rather than timestamp spelling', t => {
  const events = fixture(40);
  const betaEnd = events.find(event => event.type === 'mission_ended' && event.campaign_id === 'cmp-order-beta');
  betaEnd.at = '2026-10-16T03:40:00-07:00';
  for (const result of summaries(t, [events, swapCreation(events)])) assertMember(result, 0, 74);
});

test('nanosecond completion order survives millisecond ties and mixed timezone spelling', t => {
  const events = fixture();
  events.find(event => event.type === 'mission_ended' && event.data.outcome === 'kept').at = '2026-10-16T10:30:00.000000002Z';
  events.find(event => event.type === 'mission_ended' && event.campaign_id === 'cmp-order-beta').at = '2026-10-16T03:30:00.000000001-07:00';
  events.findLast(event => event.type === 'judge_ran' && event.campaign_id === 'cmp-order-beta').at = '2026-10-16T10:30:00.000000003Z';
  for (const result of summaries(t, [events, swapCreation(events)])) assertMember(result, 1, 72);
});

test('equal completion instants across campaigns use campaign identity rather than creation order', t => {
  const events = fixture(30);
  for (const result of summaries(t, [events, swapCreation(events)])) assertMember(result, 0, 74);
  const renamed = events.map(event => ({ ...event,
    campaign_id: event.campaign_id === 'cmp-order-alpha' ? 'cmp-order-zulu' : 'cmp-order-alpha' }));
  for (const result of summaries(t, [renamed, swapCreation(renamed)])) assertMember(result, 1, 72);
});

test('same-campaign equal-time completions retain the existing canonical mission order', t => {
  const events = fixture().filter(event => event.campaign_id === 'cmp-order-alpha' ||
    !['campaign_started', 'judge_ran'].includes(event.type));
  for (const event of events) {
    event.campaign_id = 'cmp-order-alpha';
    if (event.type === 'mission_ended') event.at = '2026-10-16T10:30:00Z';
  }
  const [result] = summaries(t, [[...events].reverse()]);
  assert.deepEqual(result.missions.map(mission => mission.mission_id), ['m-alpha-failed', 'm-alpha-kept', 'm-beta-failed']);
  assert.equal(result.members[0].repeat_failures, 0);
  assert.deepEqual(result.members, result.campaigns[0].members);
});

test('chronological streaks preserve the existing signed half-boundary reward accumulation', t => {
  const events = fixture();
  const alphaJudges = events.filter(event => event.type === 'judge_ran' && event.campaign_id === 'cmp-order-alpha');
  alphaJudges[0].data.reading = 0.3;
  alphaJudges[1].data.reading = 0.2;
  alphaJudges[2].data.reading = 0.3;
  const betaJudges = events.filter(event => event.type === 'judge_ran' && event.campaign_id === 'cmp-order-beta');
  betaJudges[0].data.reading = 0.2;
  betaJudges[1].data.reading = 0.2001;
  const common = { campaign_id: 'cmp-order-beta', origin: 'order-beta', actor: 'dummy' };
  events.push({ ...common, id: 'beta-dummy-start', seq: 7, at: '2026-10-16T10:19:00Z',
    type: 'mission_started', data: { mission_id: 'm-dummy', member: 'dummy' } });
  events.push({ ...common, id: 'beta-dummy-end', seq: 8, at: '2026-10-16T10:20:00Z',
    type: 'mission_ended', data: { mission_id: 'm-dummy', outcome: 'kept', cost_usd: 0 } });
  const [result] = summaries(t, [events]);
  const worker = result.members.find(member => member.member === 'worker');
  assert.equal(worker.repeat_failures, 1);
  assert.equal(worker.reward, 0.0001, 'only failure-streak traversal changes, not numeric accumulation order');
  assert.equal(worker.cost_usd, 0);
  assert.deepEqual(result.missions.map(mission => mission.reward), [-0.1, 0.1, 0.00005, 0.00005]);
  assert.equal(result.total_reward, 0.0001);
});
