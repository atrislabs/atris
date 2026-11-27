'use strict';

// "It should always be able to generate": reading the feed the owner's way
// (asking for more at the end, scrolling past without deciding) never makes
// the team rest. The only rests are the day's limit, nobody awake, or no model.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const feed = require('../lib/feed-core');
const team = require('../lib/feed-team');
const { changed, project } = require('./helpers/feed-project');
const { runScrollCheck } = require('../scripts/feed-scroll-check');

test('found: thirty presses of refresh in a row with two awake members, passing every idea, each bring a new card', async () => {
  const out = await runScrollCheck({ asks: 30 });
  assert.deepEqual(out.empty, [], JSON.stringify(out.empty));
  assert.ok(out.waited_ms > 0, 'a member asked a moment ago made the ask wait a few seconds, not refuse');
});

test('found: scrolling past is not a no; dismissals only move a member down the line', (t) => {
  const ctx = project(t, ['scout', 'writer']);
  for (let i = 0; i < 5; i += 1) {
    const card = feed.proposeCard(ctx.root, { as: 'scout', title: `A scrolled idea number ${i} about soap`, why: 'Buyers', env: ctx.env }).card;
    feed.passCards(ctx.root, [card.id], { env: ctx.env, now: Date.now() + 11000 });
  }
  team.ping(ctx.root, { reason: 'scroll', env: ctx.env, deps: ctx.deps });
  assert.deepEqual(ctx.thinkers[0].names, ['scout', 'writer'], 'passed ideas change nothing');
});

test('found: a member at its waiting cap retires its oldest scrolled-past ideas instead of falling silent', async (t) => {
  const ctx = project(t, ['scout']);
  const env = { ...ctx.env, ATRIS_FEED_MAX_PENDING_PER_AUTHOR: '3' };
  const ids = ['Soap shelf photo', 'Candle gift ribbon', 'Basket window sign'].map((title) => feed.proposeCard(ctx.root, { as: 'scout', title, why: 'Buyers', env }).card);
  feed.passCards(ctx.root, ids.map((c) => c.id), { env, now: Date.now() + 11000 });
  await feed.talk(ctx.root, ids[0].id, 'Keep this one', { env, deps: ctx.deps });
  const made = feed.proposeCard(ctx.root, { as: 'scout', title: 'Scent of the month card', why: 'Buyers', env });
  assert.equal(made.created, true);
  const waiting = feed.listCards(ctx.root, { filter: 'all', limit: 100, env }).cards.map((c) => c.title);
  assert.ok(waiting.includes('Scent of the month card'));
  const tasks = require('../lib/task-db');
  assert.equal(tasks.getTask(ctx.db, ids[0].source.id).status, 'open', 'one the person talked about stays');
  assert.equal(tasks.getTask(ctx.db, ids[1].source.id).status, 'archived', 'the oldest scrolled-past one made room');
  assert.equal(tasks.getTask(ctx.db, ids[2].source.id).status, 'open');
});

test('found: ideas from an ask are held to the day\'s limit, not the member\'s own daily emit cap', async (t) => {
  const ctx = project(t, ['scout']);
  const env = { ...ctx.env, ATRIS_FEED_EMITS_PER_MEMBER_PER_DAY: '1', ATRIS_FEED_MEMBER_GAP_SECONDS: '0' };
  let n = 0;
  ctx.deps.turn = async ({ onText }) => { n += 1; const text = `IDEA\nTITLE: A fresh soap idea number ${n} today\nWHY: Buyers\nEND\n`; onText(text); return { ok: true, text }; };
  for (let i = 0; i < 3; i += 1) {
    const events = [];
    changed(ctx);
    await team.pingStream(ctx.root, { reason: 'scroll', env, deps: ctx.deps, onEvent: (e) => events.push(e) });
    assert.equal(events.filter((e) => e.type === 'card_done').length, 1, `ask ${i + 1}`);
  }
});

test('found: an ask whose thinker crashed clears, and the next ask goes ahead', (t) => {
  const ctx = project(t, ['scout']);
  const marker = path.join(ctx.root, '.atris', 'state', 'feed', 'thinking-scout.json');
  fs.mkdirSync(path.dirname(marker), { recursive: true });
  fs.writeFileSync(marker, JSON.stringify({ pid: 999999, at: new Date().toISOString() }));
  const out = team.ping(ctx.root, { reason: 'scroll', env: ctx.env, deps: { ...ctx.deps, isAlive: (pid) => pid !== 999999 } });
  assert.equal(out.pinged, 1, out.reason);
  fs.writeFileSync(marker, JSON.stringify({ pid: process.pid, at: new Date(Date.now() - 10 * 60000).toISOString() }));
  changed(ctx);
  assert.equal(team.ping(ctx.root, { reason: 'scroll', env: { ...ctx.env, ATRIS_FEED_MEMBER_GAP_SECONDS: '0' }, deps: ctx.deps }).pinged, 1, 'a thought older than its limit no longer holds the ask');
});

test('found: the end of the feed rests only for the day\'s limit or nobody awake, each with its plain reason', async (t) => {
  const ctx = project(t, ['scout'], { on: false });
  assert.match(team.ping(ctx.root, { reason: 'scroll', env: ctx.env, deps: ctx.deps }).reason, /No team member is on/);
  require('../lib/member-switches').setMemberAwake('scout', true, ctx.root);
  const limit = team.ping(ctx.root, { reason: 'scroll', env: { ...ctx.env, ATRIS_FEED_PINGS_PER_DAY: '0' }, deps: ctx.deps });
  assert.match(limit.reason, /the most allowed\. It resets in/);
  assert.ok(limit.resets_at);
  assert.equal(team.ping(ctx.root, { reason: 'scroll', env: ctx.env, deps: { ...ctx.deps, lowPower: () => true } }).pinged, 1);
});
