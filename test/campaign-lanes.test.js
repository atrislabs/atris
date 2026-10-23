'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { makeLoop } = require('../lib/campaign-loop');
const { createMemoryStore, getCampaign } = require('../lib/campaign-store');
const { approvedLanes, laneAskOpen, pausedLane, LANE_ASK_KIND } = require('../lib/campaign-lanes');

function campaign() {
  const store = createMemoryStore({ origin: 'laptop' });
  store.append({ campaign_id: 'cmp-lane', type: 'campaign_started', actor: 'frontend-dev', data: { title: 'Lock apps', judge: 'npm test', budget: 10, owner: 'frontend-dev', seats: ['payments-infra'] } });
  return store;
}

// A mission in the billing lane: start works, run pauses before its first tick
// with the line `atris mission run` prints, and stop ends it.
function billingCli(store) {
  const calls = [];
  return {
    calls,
    cli: async (args) => {
      calls.push(args.slice(0, 2).join(' '));
      const id = args.includes('--mission-id') ? args[args.indexOf('--mission-id') + 1] : args[2];
      if (args[1] === 'start') {
        store.append({ campaign_id: 'cmp-lane', type: 'mission_started', actor: 'payments-infra', data: { mission_id: id, member: 'payments-infra' } });
        return { code: 0, out: '{}', err: '' };
      }
      if (args[1] === 'run') return { code: 0, out: 'Run paused: protected-lane-billing.\n', err: '' };
      if (args[1] === 'stop') {
        store.append({ campaign_id: 'cmp-lane', type: 'mission_ended', actor: 'payments-infra', data: { mission_id: id, outcome: 'failed', cost_usd: 0 } });
        return { code: 0, out: '', err: '' };
      }
      return { code: 0, out: '', err: '' };
    },
  };
}

const proposal = JSON.stringify([{ objective: 'Show a Subscribe button on locked apps', member: 'payments-infra', verify: 'npm test', estimate_usd: 0 }]);

test('a mission paused in the billing lane becomes one ask, and the campaign stops for a person', async () => {
  const store = campaign();
  const { cli, calls } = billingCli(store);
  const logs = [];
  const loop = makeLoop('/x', { parallel: 1 }, {
    store, cli, log: (line) => logs.push(line), skipReconcile: true,
    judge: () => ({ passed: false, summary: 'pass 5, fail 15' }),
    ask: async () => ({ ok: true, engine: 'claude', text: proposal }),
  });
  const result = await loop.run('cmp-lane', 10);
  assert.match(result.reason, /^needs you: 1 open ask/);
  const view = getCampaign(store, 'cmp-lane');
  assert.equal(view.asks.length, 1);
  assert.match(view.asks[0].question, /touches billing/);
  assert.match(view.asks[0].question, /Answer yes to allow it/);
  assert.deepEqual(Object.keys(view.asks[0]).sort(), ['id', 'mission_id', 'question'], 'the shared view shape does not change');
  assert.ok(calls.includes('mission stop'), 'the paused mission is stopped so it holds nothing');
  assert.ok(logs.some((l) => /needs you: it touches billing/.test(l)));
  assert.equal(laneAskOpen(store.read('cmp-lane'), 'billing'), true);
});

test('only a person answering yes approves the lane', () => {
  const opened = { type: 'ask_opened', actor: 'frontend-dev', data: { ask_id: 'a-1', question: 'q', kind: LANE_ASK_KIND, lane: 'billing' } };
  assert.deepEqual([...approvedLanes([opened])], []);
  assert.deepEqual([...approvedLanes([opened, { type: 'ask_answered', actor: 'human:keshav', data: { ask_id: 'a-1', answer: 'yes, go' } }])], ['billing']);
  assert.deepEqual([...approvedLanes([opened, { type: 'ask_answered', actor: 'human:keshav', data: { ask_id: 'a-1', answer: 'no' } }])], []);
  assert.deepEqual([...approvedLanes([opened, { type: 'ask_answered', actor: 'payments-infra', data: { ask_id: 'a-1', answer: 'yes' } }])], [], 'an agent cannot approve');
  const plain = { type: 'ask_opened', actor: 'frontend-dev', data: { ask_id: 'a-2', question: 'Deploy?' } };
  assert.deepEqual([...approvedLanes([plain, { type: 'ask_answered', actor: 'human:keshav', data: { ask_id: 'a-2', answer: 'yes' } }])], [], 'an ordinary ask approves no lane');
});

test('the pause line names the lane', () => {
  assert.equal(pausedLane('Run paused: protected-lane-billing.'), 'billing');
  assert.equal(pausedLane('Mission m-1 paused: protected-lane-security'), 'security');
  assert.equal(pausedLane('Run paused: max-wall-reached.'), null);
});
