'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { validateEvent } = require('../lib/campaign-schema');
const { createMemoryStore, createSqliteStore } = require('../lib/campaign-store');
const { buildTrace } = require('../lib/campaign-trace');
const { summarizeTrace, summarizeStoreRsi } = require('../lib/campaign-rsi');

function batch(id, after, members = ['worker', 'worker', 'worker'], before = 0.5, fault = false) {
  const events = [];
  const add = (type, data, actor = 'worker') => {
    const seq = events.length + 1;
    events.push({ id: `${id}-${seq}`, campaign_id: `cmp-${id}`, origin: id, seq,
      at: new Date(Date.UTC(2026, 9, 17) + (seq - 1) * 1000).toISOString(), type, actor, data });
  };
  add('campaign_started', { title: id, judge: 'false', owner: 'worker', budget: 1, standing: true });
  add('judge_ran', { passed: false, reading: before }, 'judge');
  members.forEach((member, i) => {
    const mission_id = `${id}-job-${i}`;
    add('mission_started', { mission_id, member });
    if (!fault || i !== members.length - 1) add('step', { mission_id, cost_usd: 0.01 }, member);
    add('mission_ended', { mission_id, outcome: fault && i === members.length - 1 ? 'fault' : 'kept', cost_usd: 0.01 }, member);
  });
  if (after !== null) add('judge_ran', { passed: false, reading: after }, 'judge');
  return events;
}

function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

// The independent oracle sums the actual six-decimal allocations as integers.
// A hundred micro-units make one public unit; exact half ties go toward +infinity.
function allocatedReward(rows, member) {
  let micros = 0n;
  for (const row of rows) {
    if (row.action.member !== member || row.reward === null) continue;
    const text = row.reward.toFixed(6);
    assert.equal(Number(text), row.reward, 'the oracle consumes existing six-decimal trace shares');
    micros += BigInt(text.replace('.', ''));
  }
  const units = micros < 0n ? -((-micros + 49n) / 100n) : (micros + 50n) / 100n;
  return units === 0n && micros < 0n ? -0 : Number(units) / 10000;
}

function checkRewards(summary, rows) {
  for (const member of summary.members) {
    assert.equal(member.reward, allocatedReward(rows, member.member), member.member);
  }
}

function readBoth(t, inputs) {
  const caller = { ...process.env };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reward-rounding-'));
  const stores = [];
  t.after(() => {
    for (const store of stores) store.close();
    fs.rmSync(root, { recursive: true, force: true });
    assert.deepEqual({ ...process.env }, caller);
  });
  const snapshot = JSON.stringify(inputs);
  freeze(inputs);
  const read = kind => inputs.map((events, i) => {
    const store = kind === 'memory' ? createMemoryStore({ origin: 'reader' })
      : createSqliteStore(path.join(root, `${i}.db`), { origin: 'reader' });
    stores.push(store);
    for (const event of events) {
      assert.equal(validateEvent(event).ok, true, event.id);
      assert.equal(store.ingest(event), true);
    }
    const ids = store.campaignIds();
    const stored = ids.map(id => store.read(id));
    const traces = stored.map(events => buildTrace(events, { redact: false }));
    const direct = stored.map(events => summarizeTrace(events));
    const summary = summarizeStoreRsi(store);
    assert.deepEqual(ids.map(id => store.read(id)), stored);
    assert.deepEqual(summary.campaigns, direct);
    assert.deepEqual(summary.missions, direct.flatMap(campaign => campaign.missions));
    direct.forEach((campaign, index) => {
      assert.deepEqual(campaign.missions.map(mission => [mission.mission_id, mission.reward, mission.cost_usd, mission.outcome]),
        traces[index].rows.map(row => [row.action.mission_id, row.reward, row.cost_usd, row.outcome]));
    });
    return { summary, traces };
  });
  const memory = read('memory');
  assert.deepEqual(read('sqlite'), memory, 'real adapters retain identical complete summaries and trace allocations');
  assert.equal(JSON.stringify(inputs), snapshot);
  return memory;
}

for (const after of [0.5001, 0.5002, 0.4999, 0.4998]) {
  test(`three real batch shares retain the measured ${after} reading in one member total`, t => {
    const [{ summary, traces }] = readBoth(t, [batch('thirds', after)]);
    const share = after === 0.5001 ? 0.000033 : after === 0.5002 ? 0.000067
      : after === 0.4999 ? -0.000033 : -0.000067;
    const expected = after === 0.5001 ? 0.0001 : after === 0.5002 ? 0.0002
      : after === 0.4999 ? -0.0001 : -0.0002;
    assert.deepEqual(traces[0].rows.map(row => row.reward), [share, share, share]);
    assert.equal(summary.total_reward, expected);
    assert.equal(summary.total_spent_usd, 0.03);
    assert.equal(summary.members[0].missions, 3);
    assert.equal(summary.members[0].kept, 3);
    assert.equal(summary.members[0].repeat_failures, 0);
    assert.equal(summary.members[0].cost_usd, 0.03);
    checkRewards(summary, traces[0].rows);
    checkRewards(summary.campaigns[0], traces[0].rows);
    assert.equal(summary.members[0].reward, expected);
    assert.equal(summary.members[0].reward_per_dollar, summary.reward_per_dollar);
  });
}

test('zero, missing after-reading and fault allocations keep their original meaning', t => {
  const results = readBoth(t, [batch('zero', 0.5), batch('unknown', null),
    batch('fault', 0.5001, ['worker', 'worker', 'worker', 'worker'], 0.5, true)]);
  const zero = results[0];
  assert.deepEqual(zero.traces[0].rows.map(row => row.reward), [0, 0, 0]);
  assert.equal(zero.summary.members[0].zero_reward_kept, 3);
  const unknown = results[1];
  assert.deepEqual(unknown.traces[0].rows.map(row => row.reward), [null, null, null]);
  assert.equal(unknown.summary.members[0].zero_reward_kept, 0);
  assert.equal(unknown.summary.members[0].judge_passed, 0);
  const fault = results[2];
  assert.deepEqual(fault.traces[0].rows.map(row => row.reward), [0.000033, 0.000033, 0.000033, null]);
  assert.equal(fault.summary.members[0].kept, 3);
  assert.equal(fault.summary.members[0].failed, 1);
  assert.equal(fault.summary.members[0].cost_usd, 0.04);
  for (const { summary, traces } of results) checkRewards(summary, traces[0].rows);
});

test('each member rounds only their allocated shares without forcing rounded member totals to conserve', t => {
  const [{ summary, traces }] = readBoth(t, [batch('halves', 0.5001, ['one', 'two'])]);
  assert.deepEqual(traces[0].rows.map(row => row.reward), [0.00005, 0.00005]);
  checkRewards(summary, traces[0].rows);
  assert.deepEqual(summary.members.map(member => member.reward), [0.0001, 0.0001]);
  assert.equal(summary.total_reward, 0.0001);
});

test('signed cancellation and exact half ties remain stable across campaign creation orders', t => {
  const groups = [batch('negative', 0.4, ['worker']), batch('positive', 0.6, ['worker']),
    batch('half', 0.5001, ['worker', 'dummy'])];
  const orders = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
  const inputs = orders.map(order => {
    const events = structuredClone(groups.flat());
    order.forEach((group, rank) => {
      const start = events.find(event => event.type === 'campaign_started' && event.campaign_id === groups[group][0].campaign_id);
      start.at = new Date(Date.UTC(2026, 9, 17) + rank * 100).toISOString();
    });
    return events;
  });
  for (const { summary, traces } of readBoth(t, inputs)) {
    const rows = traces.flatMap(trace => trace.rows);
    checkRewards(summary, rows);
    for (let i = 0; i < traces.length; i++) checkRewards(summary.campaigns[i], traces[i].rows);
    const worker = summary.members.find(member => member.member === 'worker');
    assert.equal(worker.reward, 0.0001);
    assert.equal(worker.cost_usd, 0.03);
    assert.equal(worker.repeat_failures, 0);
    assert.equal(summary.total_reward, 0.0001);
  }
});
