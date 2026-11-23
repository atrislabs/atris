'use strict';
// The person can take approved work off the waiting line, and move it within the line.
const test = require('node:test');
const assert = require('node:assert/strict');
const feed = require('../lib/feed-core');
const { project } = require('./helpers/feed-project');

function lineUp(t, titles) {
  const ctx = project(t);
  ctx.deps.maxRunning = 0;
  const ids = titles.map((title, i) => {
    const { card } = feed.proposeCard(ctx.root, { as: ['scout', 'writer', 'scout'][i] || 'scout', title, why: 'It moves the goal', env: ctx.env });
    feed.decide(ctx.root, card.id, 'approve', { env: ctx.env, deps: ctx.deps });
    return card.id;
  });
  return { ctx, ids };
}
const place = (ctx, id) => feed.readCard(ctx.root, id, { env: ctx.env }).run?.position ?? null;

test('unqueue: the work leaves the line and the card comes back to the person saying so', (t) => {
  const { ctx, ids } = lineUp(t, ['Call the ten oldest leads', 'Write the welcome note', 'Sort the inbox']);
  assert.deepEqual(ids.map((id) => place(ctx, id)), [1, 2, 3]);
  const out = feed.unqueueCard(ctx.root, ids[1], { env: ctx.env });
  assert.equal(out.card.needs_decision, true, 'it asks the person again');
  assert.equal(out.card.state, 'pending');
  assert.equal(out.card.last_failure && out.card.last_failure.reason, 'You took it off the line.');
  assert.deepEqual([place(ctx, ids[0]), place(ctx, ids[2])], [1, 2], 'the rest close up');
  assert.throws(() => feed.unqueueCard(ctx.root, ids[1], { env: ctx.env }), /not waiting in line/);
  feed.decide(ctx.root, ids[1], 'approve', { env: ctx.env, deps: ctx.deps });
  assert.equal(place(ctx, ids[1]), 3, 'approved again, it goes to the end');
});

test('move: first, last and a place, the others keep their order', (t) => {
  const { ctx, ids } = lineUp(t, ['Call the ten oldest leads', 'Write the welcome note', 'Sort the inbox']);
  assert.equal(feed.moveCard(ctx.root, ids[2], { to: 'first', env: ctx.env }).position, 1);
  assert.deepEqual(ids.map((id) => place(ctx, id)), [2, 3, 1]);
  feed.moveCard(ctx.root, ids[2], { to: 'last', env: ctx.env });
  assert.deepEqual(ids.map((id) => place(ctx, id)), [1, 2, 3]);
  feed.moveCard(ctx.root, ids[0], { to: '2', env: ctx.env });
  assert.deepEqual(ids.map((id) => place(ctx, id)), [2, 1, 3]);
  assert.throws(() => feed.moveCard(ctx.root, ids[0], { to: '0', env: ctx.env }), /usage/);
});

test('only a person changes the line', (t) => {
  const { ctx, ids } = lineUp(t, ['Call the ten oldest leads']);
  const agent = ctx.agentEnv;
  assert.throws(() => feed.unqueueCard(ctx.root, ids[0], { env: agent }), /Only a person/);
  assert.throws(() => feed.moveCard(ctx.root, ids[0], { to: 'first', env: agent }), /Only a person/);
});
