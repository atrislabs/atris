'use strict';

// Approved work on a model that can only write (the Atris cloud models: one
// chat turn, no tools on this computer). Writing work comes back as a result
// with honest proof; work that needs the project's files is refused at once,
// in plain words. Every turn and run here is a stand-in: nothing real starts.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const tasks = require('../lib/task-db');
const feed = require('../lib/feed-core');
const { project } = require('./helpers/feed-project');

function onCloud(t, ctx) {
  fs.writeFileSync(path.join(ctx.root, 'atris', '.config'), JSON.stringify({ feed: { default_engine: 'atris-fast' } }));
  const saved = process.env.ATRIS_TOKEN;
  process.env.ATRIS_TOKEN = 'test-token-never-sent';
  t.after(() => { if (saved === undefined) delete process.env.ATRIS_TOKEN; else process.env.ATRIS_TOKEN = saved; });
}

function approved(ctx, title) {
  const card = feed.proposeCard(ctx.root, { as: 'scout', title, why: 'Old leads answer more often', env: ctx.env }).card;
  feed.decide(ctx.root, card.id, 'approve', { env: ctx.env, deps: ctx.deps });
  return { card, entry: feed.readRuns(ctx.root).find((e) => e.card_id === card.id) };
}

const noRun = () => assert.fail('a model that can only write never starts member go');

test('write-only model: writing work comes back as a result, with proof that says it is only text', async (t) => {
  const ctx = project(t);
  onCloud(t, ctx);
  const { card, entry } = approved(ctx, 'Plan the calls to the ten oldest leads');
  const seen = [];
  const deps = {
    ...ctx.deps,
    spawnSync: noRun,
    turn: async ({ engine, prompt, kind }) => {
      seen.push({ engine: engine.id, prompt, kind });
      return { ok: true, text: 'SUMMARY: A five step plan for calling the ten oldest leads this week.\n1. Sort the leads by age.\n2. Call two a day.' };
    },
  };
  await feed.runEntry(ctx.root, entry.id, deps);
  assert.equal(seen.length, 1, 'one turn');
  assert.equal(seen[0].engine, 'atris-fast');
  assert.equal(seen[0].kind, 'work');
  assert.match(seen[0].prompt, /Plan the calls to the ten oldest leads/);
  assert.match(seen[0].prompt, /NEEDS_FILES/);
  const row = tasks.getTask(ctx.db, card.source.id);
  assert.equal(row.status, 'review', 'the written answer is the result, waiting for the owner');
  assert.equal(row.metadata.result, 'A five step plan for calling the ten oldest leads this week.');
  assert.match(row.metadata.latest_agent_proof, /can only write\. It opened no file, changed nothing, ran nothing and checked nothing/);
  assert.match(row.metadata.latest_agent_proof, /2\. Call two a day\./);
  assert.doesNotMatch(row.metadata.latest_agent_proof, /SUMMARY:/);
  assert.equal(feed.readRuns(ctx.root).find((e) => e.id === entry.id).status, 'ended');
});

test('write-only model: work that needs the project\'s files is refused at once, and the card says why', async (t) => {
  const ctx = project(t);
  onCloud(t, ctx);
  const { card, entry } = approved(ctx, 'Make the feed screen feel like a timeline');
  const deps = { ...ctx.deps, spawnSync: noRun, turn: async () => ({ ok: true, text: 'NEEDS_FILES It needs the feed screen changed.' }) };
  await feed.runEntry(ctx.root, entry.id, deps);
  const back = feed.listCards(ctx.root, { filter: 'all', limit: 100, env: ctx.env }).cards.find((c) => c.id === card.id);
  assert.equal(back.needs_decision, true, 'the card waits for the owner again');
  assert.match(back.last_failure.reason, /^scout's model can only write, and this needs work on the project's files\. Pick a model that can work for scout in settings\./);
  assert.equal(tasks.getTask(ctx.db, card.source.id).status, 'open');
  assert.equal(feed.readRuns(ctx.root).find((e) => e.id === entry.id).status, 'failed');
});

test('write-only model: no answer says so plainly', async (t) => {
  const ctx = project(t);
  onCloud(t, ctx);
  const { card, entry } = approved(ctx, 'Plan the calls to the ten oldest leads');
  const deps = { ...ctx.deps, spawnSync: noRun, turn: async () => ({ ok: false, text: '', error: 'out of credits' }) };
  await feed.runEntry(ctx.root, entry.id, deps);
  const back = feed.listCards(ctx.root, { filter: 'all', limit: 100, env: ctx.env }).cards.find((c) => c.id === card.id);
  assert.match(back.last_failure.reason, /^scout's model Atris 2 Fast did not answer: out of credits\.$/);
});

test('failed work: a summary that is only a model name is not shown as the member\'s words', async (t) => {
  const ctx = project(t);
  const { card, entry } = approved(ctx, 'Plan the calls to the ten oldest leads');
  const deps = {
    ...ctx.deps,
    memberStillWorking: () => false,
    spawnSync: () => {
      fs.appendFileSync(path.join(ctx.root, entry.log), '{"ticks":[{"claude":{"summary":"Atris 2 Fast"}}],"reason":"the check did not pass"}\n');
      return { status: 0 };
    },
  };
  await feed.runEntry(ctx.root, entry.id, deps);
  const back = feed.listCards(ctx.root, { filter: 'all', limit: 100, env: ctx.env }).cards.find((c) => c.id === card.id);
  assert.doesNotMatch(back.last_failure.reason, /Atris 2 Fast/);
  assert.match(back.last_failure.reason, /ended without a result: the check did not pass\./);
});
