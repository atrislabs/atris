'use strict';

// Nothing generated vanishes: new ideas land at the end of the reading
// queue, a near copy shows which card it joined, a plain-words slip gets one
// rewrite, every drop is logged, a pass never hides a card the person has not
// seen, and every finished card is a real task a fresh process can read.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const feed = require('../lib/feed-core');
const team = require('../lib/feed-team');
const { project } = require('./helpers/feed-project');

const CLI = path.join(__dirname, '..', 'bin', 'atris.js');

async function stream(ctx, text, extra = {}) {
  ctx.deps.turn = async ({ onText }) => { for (const piece of text.match(/.{1,6}/gs)) onText(piece); return { ok: true, text }; };
  const events = [];
  await team.pingStream(ctx.root, { reason: 'scroll', member: 'scout', env: { ...ctx.env, ATRIS_FEED_MEMBER_GAP_SECONDS: '0' }, deps: { ...ctx.deps, ...extra }, onEvent: (e) => events.push(e) });
  return events;
}

const idea = (title, why = 'Buyers ask for it') => `IDEA\nTITLE: ${title}\nWHY: ${why}\nSOURCE: From the shop notes\nEND\n`;

test('order: the reading queue grows at the end, and paging stays steady while ideas arrive', async (t) => {
  const ctx = project(t, ['scout']);
  for (const title of ['Soap shelf photo', 'Candle gift ribbon', 'Basket window sign']) await stream(ctx, idea(title));
  const first = feed.listCards(ctx.root, { limit: 2, env: ctx.env });
  assert.deepEqual(first.cards.map((c) => c.title), ['Soap shelf photo', 'Candle gift ribbon'], 'oldest first');
  await stream(ctx, idea('Scent of the month card'));
  const rest = feed.listCards(ctx.root, { limit: 10, cursor: first.next_cursor, env: ctx.env });
  assert.deepEqual(rest.cards.map((c) => c.title), ['Basket window sign', 'Scent of the month card'], 'the new idea lands at the end, nothing repeats');
});

test('keep: every card made is in the default list until decided or passed; a near copy says which card it joined', async (t) => {
  const ctx = project(t, ['scout']);
  const events = await stream(ctx, idea('Thank the first ten buyers') + idea('Call the warm leads today'));
  const done = events.filter((e) => e.type === 'card_done').map((e) => e.card.id);
  const listed = feed.listCards(ctx.root, { limit: 100, env: ctx.env }).cards.map((c) => c.id);
  for (const id of done) assert.ok(listed.includes(id), id);
  const again = await stream(ctx, idea('Thank the first ten buyers'));
  const joined = again.find((e) => e.type === 'card_merged');
  assert.ok(joined, 'a copy is not a drop');
  assert.equal(joined.joined, done[0]);
  assert.ok(!again.some((e) => e.type === 'card_dropped'));
  assert.ok(team.readEvents(ctx.root).some((e) => e.type === 'merged' && e.card_id === done[0]));
});

test('keep: a plain-words slip gets one rewrite by the member before it is dropped, and drops are logged', async (t) => {
  const ctx = project(t, ['scout']);
  const fixed = await stream(ctx, idea('Merge the checkout branch into the repo'), {
    rewriteTurn: async () => ({ ok: true, text: 'TITLE: Bring the new checkout to every buyer\nWHY: Buyers ask for it\n' }),
  });
  assert.ok(fixed.some((e) => e.type === 'card_rewriting'));
  assert.equal(fixed.find((e) => e.type === 'card_done').card.title, 'Bring the new checkout to every buyer');
  const lost = await stream(ctx, idea('Push the repo branch again'), { rewriteTurn: async () => ({ ok: true, text: 'TITLE: Push the repo branch again\n' }) });
  assert.match(lost.find((e) => e.type === 'card_dropped').reason, /One rewrite did not fix it/);
  const logged = team.readEvents(ctx.root).filter((e) => e.type === 'dropped');
  assert.ok(logged.length >= 1, 'the drop (and the retry\'s drop) are logged');
  assert.match(logged[0].text, /Push the repo branch again/);
  const cli = spawnSync(process.execPath, [CLI, 'feed', 'events', '--json'], { cwd: ctx.root, env: ctx.env, encoding: 'utf8' });
  assert.ok(JSON.parse(cli.stdout).events.some((e) => e.type === 'dropped'), 'readable from atris feed events');
});

test('pass: a card made seconds ago, or one never on screen, is not passed; old calls keep working', async (t) => {
  const ctx = project(t, ['scout']);
  await stream(ctx, idea('Soap shelf photo') + idea('Candle gift ribbon'));
  const [a, b] = feed.listCards(ctx.root, { env: ctx.env }).cards;
  const fresh = feed.passCards(ctx.root, [a.id], { env: ctx.env });
  assert.equal(fresh.passed, 0, 'made under ten seconds ago');
  const later = Date.now() + 11000;
  const out = feed.passCards(ctx.root, [{ id: a.id, seen: true }, { id: b.id, seen: false }], { env: ctx.env, now: later });
  assert.equal(out.passed, 1);
  assert.deepEqual(out.skipped, [b.id]);
  assert.equal(feed.passCards(ctx.root, [b.id], { env: ctx.env, now: later }).passed, 1, 'a plain list of ids still works');
  const cli = spawnSync(process.execPath, [CLI, 'feed', 'pass', '--cards', JSON.stringify([{ id: a.id, seen: false }]), '--json'], { cwd: ctx.root, env: ctx.env, encoding: 'utf8' });
  assert.equal(JSON.parse(cli.stdout).passed, 0);
});

test('keep: every finished card is a real task that a fresh process reads back', async (t) => {
  const ctx = project(t, ['scout', 'writer']);
  const ids = [];
  for (const title of ['Soap shelf photo', 'Candle gift ribbon', 'Basket window sign', 'Scent of the month card']) {
    ids.push(...(await stream(ctx, idea(title))).filter((e) => e.type === 'card_done').map((e) => e.card.id));
  }
  const fresh = spawnSync(process.execPath, [CLI, 'feed', 'cards', '--since', '0', '--limit', '100', '--json'], { cwd: ctx.root, env: ctx.env, encoding: 'utf8' });
  const seen = JSON.parse(fresh.stdout).cards.map((c) => c.id);
  assert.equal(ids.length, 4);
  for (const id of ids) assert.ok(seen.includes(id), `${id} is read back`);
});
