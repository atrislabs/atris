'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { makeCadence, parseDuration, readLessons, lessonsPath, reviewPrompt } = require('../lib/campaign-cadence');
const { makeLoop } = require('../lib/campaign-loop');
const { createMemoryStore, getCampaign } = require('../lib/campaign-store');

function setup(budget = 10) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-cadence-'));
  const store = createMemoryStore({ origin: 'laptop' });
  store.append({ campaign_id: 'cmp-c', type: 'campaign_started', actor: 'mission-lead', data: { title: 'Cadence', judge: 'npm test', budget, owner: 'mission-lead', seats: ['builder'] } });
  return { root, store };
}

function fakeCli(store) {
  return async (args) => {
    const id = args.includes('--mission-id') ? args[args.indexOf('--mission-id') + 1] : args[2];
    if (args[1] === 'start') store.append({ campaign_id: 'cmp-c', type: 'mission_started', actor: 'builder', data: { mission_id: id, member: 'builder' } });
    if (args[1] === 'run') store.append({ campaign_id: 'cmp-c', type: 'mission_ended', actor: 'builder', data: { mission_id: id, outcome: 'kept', cost_usd: 0.2 } });
    return { code: 0, out: '', err: '' };
  };
}

test('durations read as minutes by default', () => {
  assert.equal(parseDuration('50m', 0), 3000000);
  assert.equal(parseDuration('90s', 0), 90000);
  assert.equal(parseDuration('1h', 0), 3600000);
  assert.equal(parseDuration('10', 0), 600000);
  assert.equal(parseDuration('', 5), 5);
  assert.throws(() => parseDuration('soon', 0), /50m, 10m/);
});

test('rounds work, then review: lessons are written and the next plan reads them', async () => {
  const { root, store } = setup();
  let clock = 0;
  const prompts = [];
  const readings = [{ passed: false, summary: 'pass 1, fail 2' }, { passed: false, summary: 'pass 2, fail 1' }, { passed: true, summary: 'pass 3, fail 0' }];
  const ask = async (r, view, prompt) => {
    prompts.push(prompt);
    if (prompt.startsWith('You review')) return { ok: true, text: `- split work by file so missions never collide\nnot a lesson` };
    return { ok: true, text: JSON.stringify([{ objective: `Fix part ${prompts.length}`, member: 'builder', estimate_usd: 0.5 }]) };
  };
  const loop = makeLoop(root, { parallel: 1 }, {
    store, cli: fakeCli(store), log: () => {}, skipReconcile: true, ask,
    judge: async () => { clock += 60000; return readings.shift() || { passed: true, summary: 'pass 3' }; },
    lessons: (id) => readLessons(root, id),
  });
  const cadence = makeCadence(root, loop, { work: '2m', break: '1m', rounds: 5 }, {
    store, log: () => {}, ask, now: () => clock, sleep: async (ms) => { clock += ms; },
  });
  const result = await cadence.run('cmp-c');
  assert.equal(getCampaign(store, 'cmp-c').state, 'done');
  assert.ok(result.rounds >= 2, `ran ${result.rounds} rounds`);
  const file = fs.readFileSync(lessonsPath(root, 'cmp-c'), 'utf8');
  assert.match(file, /# Lessons: Cadence/);
  assert.match(file, /- split work by file so missions never collide/);
  assert.doesNotMatch(file, /not a lesson/);
  assert.equal(file.split('- split work by file').length - 1, 1, 'a lesson was written twice');
  const plans = prompts.filter((p) => p.startsWith('You plan'));
  assert.ok(plans.length >= 2);
  assert.doesNotMatch(plans[0], /Lessons from earlier rounds/);
  assert.match(plans[plans.length - 1], /Lessons from earlier rounds \(follow them\):\n- split work by file/);
});

test('a campaign that needs a person ends the rounds instead of sleeping', async () => {
  const { root, store } = setup();
  store.append({ campaign_id: 'cmp-c', type: 'ask_opened', actor: 'builder', data: { ask_id: 'a1', question: 'Deploy?' } });
  let slept = 0;
  const loop = makeLoop(root, {}, { store, cli: fakeCli(store), log: () => {}, skipReconcile: true, judge: async () => ({ passed: false }), ask: async () => ({ ok: true, text: '[]' }) });
  const cadence = makeCadence(root, loop, { work: '50m', break: '10m' }, { store, log: () => {}, now: () => 0, sleep: async () => { slept++; } });
  const result = await cadence.run('cmp-c');
  assert.equal(result.reason, 'needs you: 1 open ask');
  assert.equal(slept, 0);
  assert.match(fs.readFileSync(lessonsPath(root, 'cmp-c'), 'utf8'), /no review written this round/);
});

test('the review prompt carries the round and the lessons so far', () => {
  const view = { title: 'T', judge: 'npm test', last_judge: { passed: false, reading: 0.5 }, answer: { text: 'pass 1, fail 1' } };
  const prompt = reviewPrompt(view, { kept: 2, failed: 1, vetoed: 0, spent: 0.6, fresh: [] }, '- keep missions small');
  assert.match(prompt, /This round: 2 kept, 1 failed, 0 could not start, \$0\.6 spent/);
  assert.match(prompt, /reading 0\.5/);
  assert.match(prompt, /- keep missions small/);
});
