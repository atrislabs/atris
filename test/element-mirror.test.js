'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const mirror = require('../lib/element-mirror');
const swarm = require('../lib/element-swarm');
const room = require('../lib/feed-room');
const team = require('../lib/feed-team');
const ops = require('../lib/element-ops');
const { project } = require('./helpers/feed-project');
const delay = () => new Promise((resolve) => setTimeout(resolve, 5));
const add = (ctx, type, text) => team.recordEvent(ctx.root, { member: 'scout', type, text }, {}, { board: false });

test('only a person enables the mirror and old history is excluded', async (t) => {
  const ctx = project(t);
  add(ctx, 'progress', 'old');
  assert.throws(() => mirror.on(ctx.root, 'team', ctx.agentEnv), /Only a person/);
  const state = mirror.on(ctx.root, 'team', ctx.env);
  assert.equal(state.on, true);
  assert.deepEqual(state.sent, []);
  assert.equal((await mirror.tick(ctx.root, { deps: { mirrorSend: () => assert.fail('old event sent') } })).lines.length, 0);
});

test('outside helper activity appears in order', async (t) => {
  const ctx = project(t);
  swarm.connect(ctx.root, { as: 'codex', env: ctx.agentEnv });
  mirror.on(ctx.root, 'team', ctx.env);
  await delay();
  const task = swarm.postTask(ctx.root, { text: 'Fix the heading', as: 'scout', to: 'codex', env: ctx.agentEnv, deps: ctx.deps });
  await swarm.claim(ctx.root, { as: 'codex', card: task.card_id, env: ctx.agentEnv });
  swarm.progress(ctx.root, task.card_id, { as: 'codex', text: 'Found the heading', env: ctx.agentEnv, deps: ctx.deps });
  swarm.ask(ctx.root, task.card_id, { as: 'codex', text: 'Which title should I use?', env: ctx.agentEnv, deps: ctx.deps });
  room.reply(ctx.root, task.card_id, 'Use the shorter one', { env: ctx.env, deps: ctx.deps });
  swarm.complete(ctx.root, task.card_id, { as: 'codex', proof: 'checked', text: 'Updated the heading', env: ctx.agentEnv, deps: ctx.deps });
  const lines = [];
  const out = await mirror.tick(ctx.root, { deps: { mirrorSend: async (_channel, line) => { lines.push(line); return { ok: true }; } } });
  assert.equal(out.ok, true);
  assert.deepEqual(lines.map((line) => line.match(/posted a task|took a task|reported progress|asked the owner|replied|handed in a result/)[0]), ['posted a task', 'took a task', 'reported progress', 'asked the owner', 'replied', 'handed in a result']);
  assert.ok(lines.every((line) => !line.includes(task.card_id) && line.length < 300));
});

test('dry runs leave the cursor untouched and send nothing', async (t) => {
  const ctx = project(t); mirror.on(ctx.root, 'team', ctx.env); await delay(); add(ctx, 'progress', 'working');
  const before = fs.readFileSync(ops.stateFile(ctx.root, 'mirror.json'), 'utf8');
  const out = await mirror.tick(ctx.root, { dry: true, deps: { mirrorSend: () => assert.fail('sent') } });
  assert.equal(out.lines.length, 1);
  assert.equal(fs.readFileSync(ops.stateFile(ctx.root, 'mirror.json'), 'utf8'), before);
});

test('retry resumes after the first failed send and never repeats a saved line', async (t) => {
  const ctx = project(t); mirror.on(ctx.root, 'team', ctx.env); await delay();
  add(ctx, 'progress', 'one'); add(ctx, 'progress', 'two'); add(ctx, 'progress', 'three');
  const sent = []; let calls = 0;
  const first = await mirror.tick(ctx.root, { deps: { mirrorSend: async (_, line) => { if (++calls === 2) throw Error('offline'); sent.push(line); } } });
  assert.equal(first.error, 'offline'); assert.equal(first.left, 2);
  await mirror.tick(ctx.root, { deps: { mirrorSend: async (_, line) => { sent.push(line); } } });
  await mirror.tick(ctx.root, { deps: { mirrorSend: () => assert.fail('duplicate') } });
  assert.equal(sent.length, 3); assert.deepEqual(sent.map((s) => s.split(': ').pop()), ['one', 'two', 'three']);
});

test('off prevents sending and secrets are held back', async (t) => {
  const ctx = project(t); mirror.on(ctx.root, 'team', ctx.env); await delay();
  add(ctx, 'progress', 'api_key=sk-abcdefghijklmnopqrstuvwxyz123456789'); add(ctx, 'progress', 'safe');
  mirror.off(ctx.root);
  assert.equal((await mirror.tick(ctx.root, { deps: { mirrorSend: () => assert.fail('off') } })).on, false);
  const state = ops.readJson(ops.stateFile(ctx.root, 'mirror.json'), {}); state.on = true; ops.writeJsonAtomic(ops.stateFile(ctx.root, 'mirror.json'), state);
  const out = await mirror.tick(ctx.root, { deps: { mirrorSend: async () => {} } });
  assert.equal(out.held_back, 1); assert.equal(out.lines.length, 1);
});

test('limit reports the remaining lines and lock prevents overlap', async (t) => {
  const ctx = project(t); mirror.on(ctx.root, 'team', ctx.env); await delay();
  add(ctx, 'progress', 'one'); add(ctx, 'progress', 'two'); add(ctx, 'progress', 'three');
  let release; const wait = new Promise((resolve) => { release = resolve; });
  const running = mirror.tick(ctx.root, { limit: 1, deps: { mirrorSend: async () => wait } });
  assert.equal((await mirror.tick(ctx.root)).error, 'another tick is running');
  release(); const out = await running; assert.equal(out.lines.length, 1); assert.equal(out.left, 2);
});
