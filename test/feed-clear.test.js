'use strict';
// spends: nothing (isolated fixture, no model calls).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const feed = require('../lib/feed-core');
const room = require('../lib/feed-room');
const tasks = require('../lib/task-db');
const { project } = require('./helpers/feed-project');

test('clear deletes posts and comments, hides old cards, and preserves tasks and new posts', async (t) => {
  const ctx = project(t, ['writer']);
  const idea = feed.proposeCard(ctx.root, { as: 'writer', title: 'Draft a welcome message', why: 'Help new people', env: ctx.env }).card;
  const post = room.say(ctx.root, { text: 'What should we do?', env: ctx.env }).card;
  room.reply(ctx.root, post.id, 'Try a welcome message.', { as: 'writer', env: ctx.env, deps: ctx.deps });
  room.reply(ctx.root, idea.id, 'Make it short.', { env: ctx.env, deps: ctx.deps });
  room.react(ctx.root, idea.id, '👍', { env: ctx.env, deps: ctx.deps });
  assert.throws(() => room.clear(ctx.root, { env: ctx.env }), /Confirm/);
  assert.throws(() => room.clear(ctx.root, { env: ctx.agentEnv, confirmed: true }), /Only a person/);
  assert.equal(room.readNotes(ctx.root).length, 1);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const result = room.clear(ctx.root, { env: ctx.env, confirmed: true });
  assert.deepEqual({ posts: result.posts, comments: result.comments }, { posts: 1, comments: 2 });
  assert.equal(room.readNotes(ctx.root).length, 0);
  assert.throws(() => feed.readCard(ctx.root, post.id, { env: ctx.env }), /Card not found/);
  const kept = feed.readCard(ctx.root, idea.id, { env: ctx.env });
  assert.equal(kept.reply_count, 0);
  assert.equal(kept.reactions.length, 1);
  assert.ok(tasks.getTask(ctx.db, idea.source.id), 'the original task still exists');
  assert.ok(!feed.listCards(ctx.root, { env: ctx.env }).cards.some((card) => card.id === idea.id));
  const events = fs.readFileSync(path.join(ctx.root, '.atris/state/feed/events.jsonl'), 'utf8');
  assert.match(events, /What should we do/); // activity history stays intact
  await new Promise((resolve) => setTimeout(resolve, 5));
  const fresh = room.say(ctx.root, { text: 'A new idea after clearing.', env: ctx.env }).card;
  assert.ok(feed.listCards(ctx.root, { env: ctx.env }).cards.some((card) => card.id === fresh.id));
});

test('clear refuses unreadable feed data before touching posts', (t) => {
  const ctx = project(t, ['writer']);
  const post = room.say(ctx.root, { text: 'Keep this until clear succeeds.', env: ctx.env }).card;
  fs.writeFileSync(room.socialFile(ctx.root), '{broken');
  assert.throws(() => room.clear(ctx.root, { env: ctx.env, confirmed: true }), /Could not read/);
  assert.equal(room.readNotes(ctx.root)[0].id, post.id.slice(5));
});

test('an answer already being generated cannot restore a deleted comment', async (t) => {
  const ctx = project(t, ['writer']);
  ctx.env.ATRIS_FEED_MEMBER_GAP_SECONDS = '0';
  const idea = feed.proposeCard(ctx.root, { as: 'writer', title: 'Draft a welcome message', why: 'Help new people', env: ctx.env }).card;
  let release;
  let started;
  const entered = new Promise((resolve) => { started = resolve; });
  ctx.deps.turn = async () => { started(); return new Promise((resolve) => { release = resolve; }); };
  const pending = require('../lib/feed-team').askMember(ctx.root, { cardId: idea.id, member: 'writer', text: '', env: ctx.env, deps: ctx.deps });
  await entered;
  room.clear(ctx.root, { env: ctx.env, confirmed: true });
  release({ ok: true, text: 'Here is a welcome message.' });
  await assert.rejects(pending, /cleared before this answer arrived/);
  assert.equal(room.replies(ctx.root, idea.id, { env: ctx.env }).reply_count, 0);
});
