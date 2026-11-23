'use strict';
// The waiting count says how many cards the person can see, never cards they cleared away.
const test = require('node:test');
const assert = require('node:assert/strict');
const feed = require('../lib/feed-core');
const room = require('../lib/feed-room');
const { project } = require('./helpers/feed-project');

test('after clearing, the waiting count matches the cards shown', async (t) => {
  const ctx = project(t);
  feed.proposeCard(ctx.root, { as: 'scout', title: 'Call the ten oldest leads', why: 'It moves the goal', env: ctx.env });
  feed.proposeCard(ctx.root, { as: 'writer', title: 'Write the welcome note', why: 'It moves the goal', env: ctx.env });
  await new Promise((r) => setTimeout(r, 5));
  room.clear(ctx.root, { env: ctx.env, confirmed: true });
  await new Promise((r) => setTimeout(r, 5));
  feed.proposeCard(ctx.root, { as: 'scout', title: 'Sort the inbox', why: 'It moves the goal', env: ctx.env });
  const listed = feed.listCards(ctx.root, { filter: 'all', env: ctx.env });
  assert.deepEqual(listed.cards.map((c) => c.title), ['Sort the inbox']);
  assert.equal(listed.counts.needs_decision, 1);
});
