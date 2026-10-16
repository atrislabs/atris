'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { makeLoop, parseProposals, proposalPrompt } = require('../lib/campaign-loop');
const { createMemoryStore, getCampaign } = require('../lib/campaign-store');

function campaign(budget = 10) {
  const store = createMemoryStore({ origin: 'laptop' });
  store.append({ campaign_id: 'cmp-loop', type: 'campaign_started', actor: 'mission-lead', data: { title: 'Loop', judge: 'npm test', budget, owner: 'mission-lead', seats: ['builder', 'validator'] } });
  return store;
}

// Missions simulated straight into the store: start holds the reserve, run
// records one costed tick and ends the mission the way the real hooks do.
function fakeCli(store, { cost = 0.25, failStart = () => false, neverRuns = null, stopsShort = false } = {}) {
  const calls = [];
  return {
    calls,
    cli: async (args) => {
      calls.push(args.slice(0, 2).join(' '));
      const id = args.includes('--mission-id') ? args[args.indexOf('--mission-id') + 1] : args[2];
      if (args[1] === 'start') {
        if (failStart(id)) return { code: 2, out: '', err: 'mission start refused: campaign tank is empty' };
        const owner = args[args.indexOf('--owner') + 1];
        store.append({ campaign_id: 'cmp-loop', type: 'mission_started', actor: owner, data: { mission_id: id, member: owner } });
        store.append({ campaign_id: 'cmp-loop', type: 'budget_reserved', actor: owner, data: { mission_id: id, amount_usd: Number(args[args.indexOf('--reserve') + 1]) } });
        return { code: 0, out: '{}', err: '' };
      }
      if (args[1] === 'run' && neverRuns) return { code: 1, out: '', err: neverRuns };
      if (args[1] === 'run' && stopsShort) {
        store.append({ campaign_id: 'cmp-loop', type: 'step', actor: 'builder', data: { mission_id: id, cost_usd: cost } });
        return { code: 0, out: '', err: 'stopped: tick cap reached' };
      }
      if (args[1] === 'stop' && stopsShort) {
        store.append({ campaign_id: 'cmp-loop', type: 'mission_ended', actor: 'builder', data: { mission_id: id, outcome: 'failed', cost_usd: cost } });
        return { code: 0, out: '', err: '' };
      }
      if (args[1] === 'run') {
        store.append({ campaign_id: 'cmp-loop', type: 'step', actor: 'builder', data: { mission_id: id, cost_usd: cost } });
        store.append({ campaign_id: 'cmp-loop', type: 'mission_ended', actor: 'builder', data: { mission_id: id, outcome: 'kept', cost_usd: cost } });
        return { code: 0, out: '', err: '' };
      }
      return { code: 0, out: '', err: '' };
    },
  };
}

const proposals = (n) => JSON.stringify(Array.from({ length: n }, (_, i) => ({ objective: `Fix part ${i + 1}`, member: i % 2 ? 'validator' : 'builder', verify: `node --test test/p${i + 1}.test.js`, estimate_usd: 1 })));

test('the loop proposes, runs missions at once, judges, and stops when the judge passes', async () => {
  const store = campaign(10);
  const { cli, calls } = fakeCli(store);
  const readings = [{ passed: false, summary: '1 of 3' }, { passed: true, summary: '3 of 3' }];
  const asks = [];
  const loop = makeLoop('/x', { parallel: 2 }, {
    store, cli, log: () => {}, skipReconcile: true,
    judge: () => readings.shift(),
    ask: async (root, view, prompt) => { asks.push(prompt); return { ok: true, engine: 'claude', text: `Here you go:\n${proposals(2)}` }; },
  });
  const result = await loop.run('cmp-loop', 20);
  assert.equal(result.reason, 'finished');
  const view = getCampaign(store, 'cmp-loop');
  assert.equal(view.state, 'done');
  assert.equal(view.stop_reason, 'judge_passed');
  const work = view.missions.filter((m) => !m.id.startsWith('plan-'));
  assert.equal(work.length, 2, JSON.stringify(view.missions));
  assert.ok(work.every((m) => m.status === 'ended' && m.outcome === 'kept'));
  assert.deepEqual(work.map((m) => m.member).sort(), ['builder', 'validator']);
  assert.equal(view.budget.spent, 0.5);
  assert.equal(view.budget.reserved, 0);
  assert.deepEqual(calls.slice().sort(), ['mission run', 'mission run', 'mission start', 'mission start']);
  assert.equal(asks.length, 1);
  assert.match(asks[0], /Judge \(the campaign is done when this command exits 0\): npm test/);
});

test('the loop stops for money, for asks, and when nothing usable is proposed', async () => {
  const broke = campaign(0.4);
  const loopBroke = makeLoop('/x', { parallel: 1 }, {
    store: broke, cli: fakeCli(broke, { cost: 0.5 }).cli, log: () => {}, skipReconcile: true,
    judge: () => ({ passed: false, summary: 'not yet' }),
    ask: async () => ({ ok: true, text: JSON.stringify([{ objective: 'Spend it', member: 'builder', estimate_usd: 0.1 }]) }),
  });
  assert.equal((await loopBroke.run('cmp-loop', 20)).reason, 'budget spent');

  const asking = campaign(10);
  asking.append({ campaign_id: 'cmp-loop', type: 'mission_proposed', actor: 'builder', data: { mission_id: 'm-email', member: 'builder', objective: 'Email the customer' } });
  asking.append({ campaign_id: 'cmp-loop', type: 'mission_claimed', actor: 'builder', data: { mission_id: 'm-email', claim_key: 'email the customer' } });
  asking.append({ campaign_id: 'cmp-loop', type: 'ask_opened', actor: 'builder', data: { ask_id: 'a1', question: 'Email the customer?', mission_id: 'm-email' } });
  const loopAsk = makeLoop('/x', {}, { store: asking, cli: async () => ({ code: 0 }), log: () => {}, skipReconcile: true, judge: () => ({ passed: false }), ask: async () => ({ ok: true, text: '[]' }) });
  assert.equal((await loopAsk.run('cmp-loop')).reason, 'needs you: 1 open ask');

  const empty = campaign(10);
  const loopEmpty = makeLoop('/x', {}, { store: empty, cli: async () => ({ code: 0 }), log: () => {}, skipReconcile: true, judge: () => ({ passed: false, summary: 'no' }), ask: async () => ({ ok: true, text: 'I am not sure.' }) });
  assert.match((await loopEmpty.run('cmp-loop')).reason, /^mission-lead proposed nothing usable; next check at /);
  const view = getCampaign(empty, 'cmp-loop');
  assert.deepEqual(view.missions, [], 'an empty plan is not recorded as failed work');
  assert.equal(view.next_move.action, 'wait');
});

test('a mission that cannot start is vetoed so the queue moves on', async () => {
  const store = campaign(10);
  const loop = makeLoop('/x', { parallel: 1 }, {
    store, cli: fakeCli(store, { failStart: () => true }).cli, log: () => {}, skipReconcile: true,
    judge: () => ({ passed: false, summary: 'no' }),
    ask: async () => ({ ok: true, text: proposals(1) }),
  });
  assert.equal((await loop.step('cmp-loop')).did, 'judge');
  assert.equal((await loop.step('cmp-loop')).did, 'propose');
  const result = await loop.step('cmp-loop');
  assert.equal(result.reason, 'no claimed mission could start');
  assert.equal(getCampaign(store, 'cmp-loop').missions.find((m) => m.id.startsWith('m-')).status, 'vetoed');
});

test('a job that never ran ends as a fault with its reason, not as failed work', async () => {
  const store = campaign(10);
  const { cli, calls } = fakeCli(store, { neverRuns: 'error: engine codex not found on PATH' });
  const loop = makeLoop('/x', { parallel: 1 }, {
    store, cli, log: () => {}, skipReconcile: true,
    judge: () => ({ passed: false, summary: 'no' }),
    ask: async () => ({ ok: true, text: proposals(1) }),
  });
  await loop.step('cmp-loop');
  await loop.step('cmp-loop');
  await loop.step('cmp-loop');
  const m = getCampaign(store, 'cmp-loop').missions.find((x) => x.id.startsWith('m-'));
  assert.equal(m.status, 'ended');
  assert.equal(m.outcome, 'fault');
  assert.equal(m.reason, 'error: engine codex not found on PATH');
  assert.ok(calls.includes('mission stop'), 'the mission record is still closed');
});

for (const [passes, credited] of [[true, true], [false, undefined]]) {
  test(`a job that worked but stopped short is ${credited ? 'credited when the next check passes' : 'not credited when the next check fails'}`, async () => {
    const store = campaign(10);
    const { cli } = fakeCli(store, { stopsShort: true });
    let ran = false;
    const loop = makeLoop('/x', { parallel: 1 }, {
      store, cli: async (args) => { if (args[1] === 'run') ran = true; return cli(args); }, log: () => {}, skipReconcile: true,
      judge: () => (ran && passes ? { passed: true, summary: 'yes' } : { passed: false, summary: 'no' }),
      ask: async () => ({ ok: true, text: proposals(1) }),
    });
    for (let i = 0; i < 4; i++) await loop.step('cmp-loop');
    const m = getCampaign(store, 'cmp-loop').missions.find((x) => x.id.startsWith('m-'));
    assert.equal(m.outcome, 'failed', 'the mission keeps its own outcome');
    assert.equal(m.credited, credited);
  });
}

test('proposals are parsed strictly: unknown members fall back to the owner, verify defaults to the judge', () => {
  const view = { owner: 'mission-lead', seats: [{ member: 'builder' }], judge: 'npm test', budget: { available: 2 } };
  const parsed = parseProposals('```json\n[{"objective":"A","member":"ghost","estimate_usd":9},{"objective":"  "},{"objective":"B","member":"builder","verify":"true"}]\n```', view, 3);
  assert.deepEqual(parsed, [
    { objective: 'A', member: 'mission-lead', verify: 'npm test', estimate_usd: 2 },
    { objective: 'B', member: 'builder', verify: 'true', estimate_usd: null },
  ]);
  assert.deepEqual(parseProposals('no json here', view, 3), []);
  assert.match(proposalPrompt({ ...view, title: 'T', id: 'cmp-t', missions: [], last_judge: null, answer: { text: null }, bet: null, budget: { available: 2, total: 5 } }, 2), /at most 2 missions/);
});

test('every mission starts with an explicit time limit, so numbers in its objective are not read as one', async () => {
  for (const [options, wall] of [[{}, '2400'], [{ missionMinutes: 90 }, '5400']]) {
    const store = campaign(10);
    const starts = [];
    const { cli } = fakeCli(store);
    const loop = makeLoop('/x', { parallel: 1, ...options }, {
      store, log: () => {}, skipReconcile: true,
      cli: async (args) => {
        if (args[1] === 'start') starts.push(args);
        return cli(args);
      },
      judge: () => ({ passed: false, summary: 'not yet' }),
      ask: async () => ({ ok: true, text: JSON.stringify([{ objective: 'Split commands.test.js (437 tests, 475s)', member: 'builder', estimate_usd: 1 }]) }),
    });
    await loop.run('cmp-loop', 3);
    assert.ok(starts.length >= 1, 'a mission started');
    assert.equal(starts[0][starts[0].indexOf('--max-wall') + 1], wall);
  }
});

test('a mission run passes its live engine steps through to the campaign output', async () => {
  const store = campaign(10);
  const logs = [];
  const loop = makeLoop('/x', { parallel: 1 }, {
    store, log: (line) => logs.push(line), skipReconcile: true,
    judge: () => ({ passed: false, summary: '0 of 1' }),
    ask: async () => ({ ok: true, engine: 'claude', text: proposals(1) }),
    cli: async (args, extra = {}) => {
      const id = args.includes('--mission-id') ? args[args.indexOf('--mission-id') + 1] : args[2];
      if (args[1] === 'start') {
        store.append({ campaign_id: 'cmp-loop', type: 'mission_started', actor: 'builder', data: { mission_id: id, member: 'builder' } });
        return { code: 0, out: '{}', err: '' };
      }
      if (args[1] === 'run') {
        for (const line of ['builder does build: codex gpt-6.1-sol', '  builder 06:47  editing src/sort.js', '  builder 06:48  running: node --test', '[tick 1] status=ran']) extra.onLine?.(line);
        store.append({ campaign_id: 'cmp-loop', type: 'mission_ended', actor: 'builder', data: { mission_id: id, outcome: 'kept', cost_usd: 0 } });
      }
      return { code: 0, out: '', err: '' };
    },
  });
  await loop.step('cmp-loop');
  await loop.step('cmp-loop');
  await loop.step('cmp-loop');
  assert.ok(logs.includes('    builder 06:47  editing src/sort.js'), logs.join('\n'));
  assert.ok(logs.includes('    builder 06:48  running: node --test'));
  assert.ok(!logs.some((l) => l.includes('[tick 1]')), 'only engine steps pass through');
});

test('the command runner hands over lines from stderr too, where live engine steps are printed', async () => {
  const { runCli } = require('../lib/campaign-loop');
  const lines = [];
  const result = await runCli(['campaign', 'show', 'cmp-does-not-exist'], { cwd: require('os').tmpdir(), onLine: (line) => lines.push(line) });
  assert.notEqual(result.code, 0);
  assert.ok(result.err.length > 0, 'the message went to stderr');
  assert.ok(lines.some((line) => /no campaign cmp-does-not-exist/.test(line)), lines.join('\n'));
});

test('a campaign waiting on the world saves its wait, backs off, and replans on a new reading', async () => {
  const store = campaign(10);
  store.append({ campaign_id: 'cmp-loop', type: 'judge_ran', actor: 'judge', data: { passed: false, summary: '0 of 1' } });
  const MIN = 60000;
  let t = Date.UTC(2026, 9, 16, 3, 0, 0);
  let asks = 0;
  let summary = '0 of 1';
  const deps = {
    store, log: () => {}, skipReconcile: true, now: () => t, cli: async () => ({ code: 0 }),
    judge: async () => ({ passed: false, summary }),
    ask: async () => { asks += 1; return { ok: true, text: 'Nothing to do until the payment lands.' }; },
  };
  const loop = makeLoop('/x', { parallel: 1 }, deps);
  await loop.tick('cmp-loop');
  const first = getCampaign(store, 'cmp-loop').next_move;
  assert.equal(first.wake_at - t, 10 * MIN);
  t += 5 * MIN;
  // A new process honors the saved wait and does nothing early.
  assert.match((await makeLoop('/x', { parallel: 1 }, deps).tick('cmp-loop')).reason, /^waiting on the world/);
  t = first.wake_at;
  await loop.tick('cmp-loop');
  assert.equal(getCampaign(store, 'cmp-loop').next_move.wait_ms, 20 * MIN);
  assert.equal(asks, 1);
  t += 20 * MIN;
  summary = 'payment seen';
  await loop.tick('cmp-loop');
  assert.equal(getCampaign(store, 'cmp-loop').next_move, undefined);
  await loop.tick('cmp-loop');
  assert.equal(asks, 2);
  // Anything new ends a wait: a proposed mission is not held back by it.
  store.append({ campaign_id: 'cmp-loop', type: 'mission_proposed', actor: 'builder', data: { mission_id: 'm-x', member: 'builder', objective: 'x' } });
  assert.equal(getCampaign(store, 'cmp-loop').next_move, undefined);
});
