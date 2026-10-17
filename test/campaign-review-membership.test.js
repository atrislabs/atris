'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');

const environment = () => createHash('sha256').update(JSON.stringify(Object.entries(process.env).sort())).digest('hex');
const caller = { environment: environment(), cwd: process.cwd() };
const { makeCadence, lessonsPath, readLessons } = require('../lib/campaign-cadence');
const { createMemoryStore, getCampaign } = require('../lib/campaign-store');

const ID = 'cmp-review-membership';
const LESSON = '- preserve the measured round result';

function workspace(t) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'rvm-'));
  const root = path.join(parent, 'work');
  const sentinel = path.join(parent, 'foreign.txt');
  const store = createMemoryStore({ origin: 'review', now: () => '2026-10-17T00:00:00Z' });
  t.after(() => {
    try {
      store.close();
      fs.rmSync(root, { recursive: true, force: true });
      assert.equal(fs.readFileSync(sentinel, 'utf8'), 'foreign fixture stays\n');
      assert.equal(environment(), caller.environment, 'parent environment digest stays unchanged');
      assert.equal(process.cwd(), caller.cwd);
    } finally { fs.rmSync(parent, { recursive: true, force: true }); }
  });
  fs.mkdirSync(root);
  fs.writeFileSync(sentinel, 'foreign fixture stays\n');
  const add = (type, data) => store.append({ campaign_id: ID, type, actor: 'owner', data });
  add('campaign_started', { title: 'Owned review', judge: 'false', owner: 'owner', budget: 100, standing: true });
  add('judge_ran', { passed: false, reading: 0.5, summary: 'same reading' });
  const job = (id, outcome = 'kept', cost = 0.01) => {
    add('mission_started', { mission_id: id, member: 'worker' });
    add('mission_ended', { mission_id: id, outcome, cost_usd: cost });
  };
  const prompts = [];
  const cadence = makeCadence(root, null, {}, {
    store, log: () => {}, now: () => Date.UTC(2026, 9, 17),
    ask: async (actualRoot, view, prompt) => {
      assert.equal(actualRoot, root);
      assert.equal(view.id, ID);
      assert.match(prompt, /^You review/);
      prompts.push(prompt);
      return { ok: true, text: LESSON };
    },
  });
  return { root, store, add, job, prompts, review: before => cadence.review(ID, before) };
}

test('public review uses bounded linear before-row identity reads for unchanged history', async t => {
  const h = workspace(t);
  for (let i = 0; i < 256; i++) h.job(`old-${i}`);
  const before = getCampaign(h.store, ID);
  const snapshot = JSON.stringify(before);
  const events = h.store.read(ID);
  let reads = 0;
  for (const row of before.missions) {
    const id = row.id;
    Object.defineProperty(row, 'id', { enumerable: true, get() { reads++; return id; } });
    Object.freeze(row);
  }
  Object.freeze(before.missions);
  Object.freeze(before);
  const result = await h.review(before);
  const observedReads = reads;
  const bound = 12 * (before.missions.length + result.view.missions.length);
  assert.deepEqual(result.summary, { kept: 0, failed: 0, vetoed: 0, spent: 0, fresh: [] });
  assert.equal(result.quiet, true);
  assert.deepEqual(result.lessons, []);
  assert.deepEqual(h.prompts, []);
  assert.deepEqual(h.store.read(ID), events);
  assert.equal(JSON.stringify(before), snapshot, 'delegated getters and the caller view remain unchanged');
  assert.equal(readLessons(h.root, ID), '');
  assert.equal(fs.readFileSync(path.join(path.dirname(h.root), 'foreign.txt'), 'utf8'), 'foreign fixture stays\n');
  assert.ok(observedReads <= bound, `actual before-row id reads ${observedReads} exceed linear bound ${bound}`);
});

test('membership retains any duplicate id-status pair without joined-key collisions', async t => {
  const h = workspace(t);
  for (const id of ['shared', 'same-fields', 'work:ended', 'pipe|ended', 'changed-status']) h.job(id);
  h.job('new-id', 'failed');
  const before = getCampaign(h.store, ID);
  const row = id => before.missions.find(mission => mission.id === id);
  before.missions = [
    { ...row('shared') }, { ...row('shared'), status: 'claimed' },
    { ...row('same-fields'), outcome: 'failed', cost_usd: 999 },
    { id: 'work', status: 'ended:ended' }, { id: 'pipe', status: 'ended|ended' },
    { ...row('changed-status'), status: 'running' },
  ];
  const snapshot = JSON.stringify(before);
  const events = h.store.read(ID);
  const result = await h.review(before);
  assert.deepEqual(result.summary.fresh.map(mission => mission.id), ['work:ended', 'pipe|ended', 'changed-status', 'new-id']);
  assert.equal(result.summary.kept, 3);
  assert.equal(result.summary.failed, 1);
  assert.equal(result.summary.vetoed, 0);
  assert.equal(result.summary.spent, 0);
  assert.equal(result.quiet, false);
  assert.deepEqual(result.lessons, [LESSON]);
  assert.match(h.prompts[0], /This round: 3 kept, 1 failed, 0 could not start/);
  assert.ok(h.prompts[0].indexOf('- work:ended: ended') < h.prompts[0].indexOf('- pipe|ended: ended'));
  assert.ok(h.prompts[0].indexOf('- pipe|ended: ended') < h.prompts[0].indexOf('- changed-status: ended'));
  const repeated = await h.review(before);
  assert.deepEqual(repeated.lessons, [], 'a known lesson is not appended twice');
  assert.equal(readLessons(h.root, ID), LESSON + '\n- (no review written this round)');
  assert.equal(h.prompts.length, 2);
  assert.match(h.prompts[1], /Lessons so far:\n- preserve the measured round result/);
  assert.deepEqual(h.store.read(ID), events);
  assert.equal(JSON.stringify(before), snapshot);
});

test('real lifecycle changes preserve fresh order, spend, prompts and a subsequent quiet review', async t => {
  const h = workspace(t);
  h.add('mission_started', { mission_id: 'worked', member: 'worker' });
  h.add('mission_proposed', { mission_id: 'refused', member: 'worker' });
  h.add('mission_claimed', { mission_id: 'refused', claim_key: 'one-owned-job' });
  h.job('already-ended', 'kept', 0.04);
  const before = getCampaign(h.store, ID);
  const snapshot = JSON.stringify(before);
  h.add('mission_ended', { mission_id: 'worked', outcome: 'kept', cost_usd: 0.02 });
  h.add('mission_vetoed', { mission_id: 'refused', reason: 'owned refusal' });
  h.job('new-failure', 'failed', 0.03);
  h.add('mission_ended', { mission_id: 'already-ended', outcome: 'reverted', cost_usd: 0.01 });
  const after = getCampaign(h.store, ID);
  const events = h.store.read(ID);
  const result = await h.review(before);
  assert.deepEqual(result.summary.fresh.map(mission => mission.id), ['worked', 'refused', 'new-failure']);
  assert.equal(result.summary.kept, 1);
  assert.equal(result.summary.failed, 1);
  assert.equal(result.summary.vetoed, 1);
  assert.equal(result.summary.spent, 0.06);
  assert.deepEqual(result.view, after);
  assert.equal(result.quiet, false);
  assert.match(h.prompts[0], /This round: 1 kept, 1 failed, 1 could not start/);
  assert.ok(h.prompts[0].indexOf('- worked: ended') < h.prompts[0].indexOf('- refused: vetoed'));
  assert.ok(h.prompts[0].indexOf('- refused: vetoed') < h.prompts[0].indexOf('- new-failure: ended'));
  const quiet = await h.review(after);
  assert.deepEqual(quiet.summary, { kept: 0, failed: 0, vetoed: 0, spent: 0, fresh: [] });
  assert.equal(quiet.quiet, true);
  assert.deepEqual(quiet.lessons, []);
  assert.equal(h.prompts.length, 1);
  assert.equal(readLessons(h.root, ID), LESSON);
  assert.match(fs.readFileSync(lessonsPath(h.root, ID), 'utf8'), /nothing ended and the reading held/);
  assert.deepEqual(h.store.read(ID), events);
  assert.equal(JSON.stringify(before), snapshot);
});
