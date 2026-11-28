'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { askOwner, chosenRunner, makeLoop, parseProposals, sanitizeProposalVerify } = require('../lib/campaign-loop');
const { createMemoryStore, getCampaign } = require('../lib/campaign-store');
const memberEngine = require('../lib/member-engine');
const engineAsk = require('../lib/engine-ask');

function campaign() {
  const store = createMemoryStore({ origin: 'laptop' });
  store.append({ campaign_id: 'cmp-wc', type: 'campaign_started', actor: 'mission-lead', data: { title: 'WC', judge: 'npm test', budget: 10, owner: 'mission-lead', seats: ['builder'] } });
  return store;
}

test('sanitizeProposalVerify keeps bare commands and drops piped ones', () => {
  assert.equal(sanitizeProposalVerify('  node --test a.js && node --test b.js ', 'npm test'), 'node --test a.js && node --test b.js');
  assert.equal(sanitizeProposalVerify('node --test a.js | tail -n 10', 'npm test'), 'npm test');
  assert.equal(sanitizeProposalVerify('a || b', 'npm test'), 'a || b');
  assert.equal(sanitizeProposalVerify('   ', 'npm test'), 'npm test');
  assert.equal(sanitizeProposalVerify(undefined), '');
});

test('parseProposals swaps a piped verify for the judge', () => {
  const store = campaign();
  const view = getCampaign(store, 'cmp-wc');
  const parsed = parseProposals(JSON.stringify([
    { objective: 'A', verify: 'node --test a.js | tail -n 10' },
    { objective: 'B', verify: 'node --test b.js' },
  ]), view, 2);
  assert.deepEqual(parsed.map((p) => p.verify), ['npm test', 'node --test b.js']);
});

test('chosenRunner keeps an effort pin', () => {
  assert.deepEqual(chosenRunner('claude opus 5.5 low'), { runner: 'claude', model: 'claude-opus-5-5', effort: 'low' });
  assert.deepEqual(chosenRunner('auto'), { runner: 'auto', model: '', effort: '' });
  assert.deepEqual(chosenRunner(''), { runner: 'auto', model: '', effort: '' });
});

async function startArgs(options) {
  const store = campaign();
  const starts = [];
  const cli = async (args) => {
    if (args[1] === 'start') {
      starts.push(args);
      const id = args[args.indexOf('--mission-id') + 1];
      store.append({ campaign_id: 'cmp-wc', type: 'mission_started', actor: 'builder', data: { mission_id: id, member: 'builder' } });
      return { code: 0, out: '{}', err: '' };
    }
    if (args[1] === 'run') {
      const id = args[2];
      store.append({ campaign_id: 'cmp-wc', type: 'mission_ended', actor: 'builder', data: { mission_id: id, outcome: 'kept', cost_usd: 0.1 } });
    }
    return { code: 0, out: '', err: '' };
  };
  const readings = [{ passed: false, summary: '0 of 1' }];
  const loop = makeLoop('/x', { parallel: 1, ...options }, {
    store, cli, log: () => {}, skipReconcile: true, brief: () => '',
    judge: () => readings.shift() || { passed: true, summary: 'ok' },
    ask: async () => ({ ok: true, engine: 'claude', text: JSON.stringify([{ objective: 'Fix', member: 'builder', verify: 'node --test x.js' }]) }),
  });
  await loop.run('cmp-wc', 3);
  assert.ok(starts.length >= 1);
  return starts[0];
}

test('makeLoop passes --effort only when one was pinned', async () => {
  const fromOption = await startArgs({ effort: 'LOW' });
  assert.deepEqual(fromOption.slice(fromOption.indexOf('--effort'), fromOption.indexOf('--effort') + 2), ['--effort', 'low']);
  const fromRunner = await startArgs({ runner: 'claude opus 5.5 low' });
  assert.deepEqual(fromRunner.slice(fromRunner.indexOf('--effort'), fromRunner.indexOf('--effort') + 2), ['--effort', 'low']);
  assert.equal(fromRunner[fromRunner.indexOf('--model') + 1], 'claude-opus-5-5');
  const plain = await startArgs({});
  assert.equal(plain.includes('--effort'), false);
});

test('askOwner plans at low effort', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'campaign-wc-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.mock.method(memberEngine, 'resolveEngineForMember', () => ({ engine: { id: 'claude' }, model: 'm' }));
  const run = t.mock.method(engineAsk, 'runEngineAskJobs', async () => [{ stdout: '[]', ok: true }]);
  await askOwner(root, { owner: 'planner', id: 'wc' }, 'plan');
  assert.equal(run.mock.calls[0].arguments[0][0].effort, 'low');
});
