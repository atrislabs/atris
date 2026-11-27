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

test('help: clear has its own line and does not split say from its explanation', (t) => {
  const ctx = project(t, ['writer']);
  const out = require('node:child_process').spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'atris.js'), 'feed', 'help'], { encoding: 'utf8', cwd: ctx.root, env: { ...process.env, ...ctx.env } });
  const lines = out.stdout.split('\n');
  const say = lines.findIndex((line) => line.includes('atris feed say "'));
  assert.match(lines[say + 1], /a short note in the feed/);
  assert.ok(lines.some((line) => line.includes('atris feed clear --confirm')));
});

test('after clearing, working shelf agrees on needs_decision and new_results while keeping live work', async (t) => {
  const ctx = project(t, ['writer', 'scout']);
  feed.proposeCard(ctx.root, { as: 'writer', title: 'Draft a welcome message', why: 'Help new people', env: ctx.env });
  tasks.addTask(ctx.db, {
    workspaceRoot: ctx.root,
    title: 'Ship checkout polish',
    status: 'done',
    metadata: { result: 'Checkout loads twice as fast.' },
  });
  const live = feed.proposeCard(ctx.root, { as: 'scout', title: 'Call the ten oldest leads', why: 'Old leads answer more often', env: ctx.env }).card;
  feed.decide(ctx.root, live.id, 'approve', { env: ctx.env, deps: ctx.deps });

  const before = feed.listCards(ctx.root, { filter: 'all', env: ctx.env });
  assert.equal(before.counts.needs_decision, 1);
  assert.equal(before.counts.new_results, 1);
  assert.equal(before.counts.working, 1);

  await new Promise((resolve) => setTimeout(resolve, 5));
  room.clear(ctx.root, { env: ctx.env, confirmed: true });

  const allShelf = feed.listCards(ctx.root, { filter: 'all', env: ctx.env });
  const waitingShelf = feed.listCards(ctx.root, { filter: 'needs_decision', env: ctx.env });
  const workingShelf = feed.listCards(ctx.root, { filter: 'working', env: ctx.env });

  for (const [name, shelf] of [['all', allShelf], ['needs_decision', waitingShelf], ['working', workingShelf]]) {
    assert.equal(shelf.counts.needs_decision, 0, `${name} shelf needs_decision after clear`);
    assert.equal(shelf.counts.new_results, 0, `${name} shelf new_results after clear`);
    assert.equal(shelf.counts.working, 1, `${name} shelf working count after clear`);
  }
  assert.deepEqual(workingShelf.cards.map((card) => card.id), [live.id]);
});
