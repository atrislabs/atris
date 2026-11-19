'use strict';

// Ideas grounded in what the project knows: a small digest of the journal,
// features, wiki, tasks and decisions; each idea names what sparked it;
// pictures that are about the card and only real numbers; quick choices in
// a conversation; and lasting notes the owner teaches the team.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const tasks = require('../lib/task-db');
const feed = require('../lib/feed-core');
const team = require('../lib/feed-team');
const digest = require('../lib/feed-digest');
const { changed, project } = require('./helpers/feed-project');

function seed(ctx) {
  const w = (rel, text) => { fs.mkdirSync(path.dirname(path.join(ctx.root, rel)), { recursive: true }); fs.writeFileSync(path.join(ctx.root, rel), text); };
  w('atris/logs/2026/2026-11-10.md', '# 2026-11-10\n\n## Old day\n- Talked about the very old plan\n');
  w('atris/logs/2026/2026-11-11.md', '# 2026-11-11\n\n## Pricing\n- Three buyers asked why candles cost 9 dollars\n');
  w('atris/logs/2026/2026-11-12.md', '# 2026-11-12\n\n## Checkout\n- The checkout broke again on empty baskets\n');
  w('atris/logs/2026/2026-11-13.md', '# 2026-11-13\n\n## Checkout\n- The checkout broke on empty baskets a third time\n- Sales this week: 14 soaps and 6 candles\n');
  w('atris/logs/archive/2025-all.md', '- SECRET ARCHIVE LINE never to be read\n');
  w('atris/features/gift-cards/idea.md', '# Gift cards\n\nStatus: stalled, waiting on a price\n');
  w('atris/features/checkout/idea.md', '# Checkout\n\nStatus: live, but empty baskets break it\n');
  w('atris/wiki/index.md', '# Wiki\n\n- [[atris/wiki/pricing.md]] — how we price candles and soap\n- [[atris/wiki/team.md]] — who does what\n');
  w('atris/wiki/pricing.md', '# Pricing\n\nWe promised a bundle price for soap and candles. Not built yet.\n');
  w('atris/wiki/team.md', '# Team\n\nScout reads, builder builds.\n');
  w('atris/team/scout/MISSION.md', '# Mission\n\nFind what buyers trip on and propose the smallest fix.\n');
}

// --------------------------------------------------------------- digest

test('digest: the journal, features, wiki, tasks and decisions, small, from indexes, never archives', (t) => {
  const ctx = project(t);
  seed(ctx);
  feed.setTheme(ctx.root, 'Sell more soap and candles to buyers', { env: ctx.env });
  tasks.addTask(ctx.db, { title: 'Fix the empty basket bug', workspaceRoot: ctx.root });
  const card = feed.proposeCard(ctx.root, { as: 'scout', title: 'Raise the candle price', why: 'More money', env: ctx.env }).card;
  feed.decide(ctx.root, card.id, 'dismiss', { note: 'buyers already complain', env: ctx.env, deps: ctx.deps });
  const { text, cached } = digest.projectDigest(ctx.root);
  assert.equal(cached, false);
  assert.ok(text.length <= digest.DIGEST_TOKEN_BUDGET * 4, `${text.length} characters`);
  assert.match(text, /Sell more soap and candles/);
  assert.match(text, /2026-11-13:[\s\S]*broke on empty baskets a third time/);
  assert.match(text, /2026-11-12:[\s\S]*broke again on empty baskets/);
  assert.doesNotMatch(text, /very old plan/, 'only the last few days');
  assert.doesNotMatch(text, /status: archived|task: PRJ/, 'machine fields are left out');
  assert.doesNotMatch(text, /SECRET ARCHIVE/, 'never the archives');
  assert.match(text, /gift cards: stalled, waiting on a price/);
  assert.match(text, /page pricing: We promised a bundle price/, 'the wiki page nearest the goal');
  assert.match(text, /open: Fix the empty basket bug/);
  assert.match(text, /said no: Raise the candle price \(buyers already complain\)/);
  assert.equal(digest.projectDigest(ctx.root).cached, true, 'kept until something changes');
  fs.appendFileSync(path.join(ctx.root, 'atris', 'logs', '2026', '2026-11-13.md'), '- A buyer asked for gift cards\n');
  const fresh = digest.projectDigest(ctx.root);
  assert.equal(fresh.cached, false);
  assert.match(fresh.text, /asked for gift cards/);
});

test('digest: every idea round and talk turn gets it, with the member\'s mission, and asks for connected ideas', async (t) => {
  const ctx = project(t);
  seed(ctx);
  const prompt = team.ideaPrompt(ctx.root, 'scout', 'scroll');
  assert.match(prompt, /broke on empty baskets/);
  assert.match(prompt, /Your mission: .*smallest fix/);
  assert.match(prompt, /connect two things/);
  assert.match(prompt, /SOURCE: /);
  const card = feed.proposeCard(ctx.root, { as: 'scout', title: 'Fix the empty basket checkout', why: 'Buyers stop there', env: ctx.env }).card;
  await feed.talk(ctx.root, card.id, 'How often does it break?', { env: ctx.env, deps: ctx.deps });
  assert.match(ctx.turns[0].prompt, /a third time/);
});

// --------------------------------------------------------------- sources

function streaming(text) {
  return async ({ onText }) => { for (const piece of text.match(/.{1,6}/gs)) onText(piece); return { ok: true, text }; };
}

async function round(ctx, text) {
  ctx.deps.turn = streaming(text);
  const events = [];
  await team.pingStream(ctx.root, { reason: 'scroll', member: 'scout', env: { ...ctx.env, ATRIS_FEED_MEMBER_GAP_SECONDS: '0' }, deps: ctx.deps, onEvent: (e) => events.push(e) });
  return events;
}

test('source: each idea names what sparked it on the card, with the exact file only in detail', async (t) => {
  const ctx = project(t);
  seed(ctx);
  const events = await round(ctx, 'IDEA\nTITLE: Stop the checkout breaking on empty baskets\nWHY: It broke three times this week\n'
    + 'SOURCE: From this week\'s notes on checkout\nSOURCE_REF: atris/logs/2026/2026-11-13.md\nEND\n');
  const card = events.find((e) => e.type === 'card_done').card;
  assert.equal(card.sparked_by, 'From this week\'s notes on checkout');
  assert.match(card.detail, /Sparked by: atris\/logs\/2026\/2026-11-13\.md/);
  const jargon = await round(ctx, 'IDEA\nTITLE: Show a bundle price for soap and candles\nWHY: We promised it\nSOURCE: From atris/wiki/pricing.md\nEND\n');
  assert.match(jargon.find((e) => e.type === 'card_dropped').reason, /plain words/);
});

test('source: a member that cannot say what sparked its ideas is asked less often', async (t) => {
  const ctx = project(t, ['scout', 'writer']);
  for (let i = 0; i < 4; i += 1) {
    await round(ctx, `IDEA\nTITLE: A general idea number ${i} for buyers\nWHY: It might help\nSOURCE: none\nEND\n`);
  }
  const rows = require('../lib/feed-core')._internal.ideaRows(ctx.root);
  assert.ok(rows.every((row) => row.metadata.feed.unsourced === true));
  changed(ctx);
  team.ping(ctx.root, { reason: 'scroll', env: { ...ctx.env, ATRIS_FEED_MEMBER_GAP_SECONDS: '0' }, deps: ctx.deps });
  assert.deepEqual(ctx.thinkers[0].names, ['writer', 'scout'], 'asked after the others, never left out');
});

// --------------------------------------------------------------- visuals

test('visuals: a picture not about the card, empty or decorative is left off; the card stays', async (t) => {
  const ctx = project(t);
  seed(ctx);
  const cards = [
    ['Stop empty baskets breaking checkout', '{"kind": "steps", "steps": ["Paint the moon", "Sing loudly"]}'],
    ['Warn buyers before an empty order', '{"kind": "before_after", "before": "Empty orders break", "after": "Empty orders break"}'],
    ['Keep the pay page from failing', '{"kind": "drawing", "svg": "<svg xmlns=\\"http://www.w3.org/2000/svg\\" viewBox=\\"0 0 10 10\\"><rect width=\\"5\\" height=\\"5\\"/></svg>", "alt": "The pay page"}'],
  ];
  for (const [name, visual] of cards) {
    const events = await round(ctx, `IDEA\nTITLE: ${name}\nWHY: Buyers leave at checkout\nSOURCE: From the checkout notes\nVISUAL: ${visual}\nEND\n`);
    assert.ok(events.some((e) => e.type === 'card_visual_dropped'), name);
    assert.equal(events.find((e) => e.type === 'card_done').card.visual, null, name);
  }
  const good = await round(ctx, 'IDEA\nTITLE: Draw the path from basket to receipt\nWHY: Buyers leave at checkout\nSOURCE: From the checkout notes\n'
    + 'VISUAL: {"kind": "drawing", "svg": "<svg xmlns=\\"http://www.w3.org/2000/svg\\" viewBox=\\"0 0 120 40\\"><rect x=\\"2\\" y=\\"2\\" width=\\"50\\" height=\\"30\\"/><text x=\\"6\\" y=\\"20\\">Empty basket</text><path d=\\"M52 17 L70 17\\"/><rect x=\\"70\\" y=\\"2\\" width=\\"48\\" height=\\"30\\"/><text x=\\"74\\" y=\\"20\\">Checkout</text></svg>", "alt": "Empty basket to checkout"}\nEND\n');
  assert.equal(good.find((e) => e.type === 'card_done').card.visual.kind, 'drawing');
});

test('visuals: a chart only from real numbers found in the named project file', async (t) => {
  const ctx = project(t);
  seed(ctx);
  const chart = '{"kind": "chart", "chart": "bar", "title": "Soaps and candles sold this week", "data": [{"label": "soaps", "value": 14}, {"label": "candles", "value": 6}]}';
  const real = await round(ctx, `IDEA\nTITLE: Put candles next to soaps where buyers look\nWHY: Candles sell less than soaps\nSOURCE: From this week's sales notes\nSOURCE_REF: atris/logs/2026/2026-11-13.md\nVISUAL: ${chart}\nEND\n`);
  assert.equal(real.find((e) => e.type === 'card_done').card.visual.kind, 'chart');
  const made = await round(ctx, `IDEA\nTITLE: Sell candles in pairs to buyers of soaps\nWHY: Candles sell less than soaps\nSOURCE: From this week's sales notes\nSOURCE_REF: atris/logs/2026/2026-11-12.md\nVISUAL: ${chart}\nEND\n`);
  assert.match(made.find((e) => e.type === 'card_visual_dropped').reason, /These numbers are not in/);
  const none = await round(ctx, `IDEA\nTITLE: Offer a candle with every second soap sold\nWHY: Candles sell less than soaps\nSOURCE: From this week's sales notes\nVISUAL: ${chart}\nEND\n`);
  assert.match(none.find((e) => e.type === 'card_visual_dropped').reason, /needs the project file/);
});

// --------------------------------------------------------------- choices

test('choices: a reply can offer up to four quick picks; choosing one answers with it', async (t) => {
  const ctx = project(t);
  const card = feed.proposeCard(ctx.root, { as: 'scout', title: 'Fix the empty basket checkout', why: 'Buyers stop there', env: ctx.env }).card;
  ctx.deps.answer = () => 'Which do you want first?\nCHOICES ["Fix it today", "Show a message first", "Ask buyers", "Wait a week", "A fifth one"]';
  const events = [];
  const out = await feed.talk(ctx.root, card.id, 'What next?', { env: ctx.env, deps: ctx.deps, onEvent: (e) => events.push(e) });
  assert.deepEqual(out.choices.map((c) => c.id), ['c1', 'c2', 'c3', 'c4']);
  assert.equal(out.reply.text, 'Which do you want first?');
  assert.ok(!events.some((e) => e.type === 'chunk' && /CHOICES/.test(e.text)), 'the choices line is never shown as words');
  assert.equal(events.find((e) => e.type === 'choices').choices.length, 4);
  assert.equal(feed.listMessages(ctx.root, card.id, { env: ctx.env }).messages[1].choices[1].label, 'Show a message first');
  ctx.deps.answer = () => 'Good, a message first.';
  const picked = await feed.talk(ctx.root, card.id, '', { choose: 'c2', env: ctx.env, deps: ctx.deps });
  assert.equal(picked.message.text, 'Show a message first');
  assert.equal(picked.message.chose, 'c2');
  await assert.rejects(feed.talk(ctx.root, card.id, '', { choose: 'c9', env: ctx.env, deps: ctx.deps }), (e) => e.status === 404);
  ctx.deps.answer = () => 'Ok.\nCHOICES ["Merge the branch now", "a"]';
  const bad = await feed.talk(ctx.root, card.id, 'And?', { env: ctx.env, deps: ctx.deps });
  assert.deepEqual(bad.choices, [], 'one plain choice is not a choice');
});

// --------------------------------------------------------------- notes

test('notes: a lasting preference said in a conversation is kept, shown back, used in later rounds, and can be forgotten', async (t) => {
  const ctx = project(t);
  const card = feed.proposeCard(ctx.root, { as: 'scout', title: 'Run paid ads for candles', why: 'More buyers', env: ctx.env }).card;
  ctx.deps.answer = () => 'Understood, no paid ads.\nNOTE {"text": "Never suggest paid ads", "scope": "team"}';
  const events = [];
  const out = await feed.talk(ctx.root, card.id, 'Never suggest paid ads, ever.', { env: ctx.env, deps: ctx.deps, onEvent: (e) => events.push(e) });
  assert.equal(out.learned.line, 'Noted for the whole team: Never suggest paid ads');
  assert.match(out.learned.forget, /atris feed notes forget fn-/);
  assert.ok(events.some((e) => e.type === 'learned'));
  assert.match(fs.readFileSync(path.join(ctx.root, 'atris', 'lessons.md'), 'utf8'), /What the owner taught us in the feed[\s\S]*Never suggest paid ads/);
  ctx.deps.answer = () => 'Sure.\nNOTE {"text": "Show the number first", "scope": "member"}';
  await feed.talk(ctx.root, card.id, 'Always show me the number first.', { env: ctx.env, deps: ctx.deps });
  assert.match(fs.readFileSync(path.join(ctx.root, 'atris', 'team', 'scout', 'lessons.md'), 'utf8'), /Show the number first/);
  const notes = digest.listNotes(ctx.root);
  assert.deepEqual(notes.map((n) => n.scope).sort(), ['member', 'team']);
  assert.match(team.ideaPrompt(ctx.root, 'scout', 'scroll'), /Never suggest paid ads[\s\S]*Show the number first \(for you\)/);
  assert.match(team.ideaPrompt(ctx.root, 'writer', 'scroll'), /Never suggest paid ads/);
  assert.doesNotMatch(team.ideaPrompt(ctx.root, 'writer', 'scroll'), /Show the number first/, 'a member\'s own note stays its own');
  digest.forgetNote(ctx.root, out.learned.id);
  assert.doesNotMatch(digest.notesForPrompt(ctx.root, 'scout'), /Never suggest paid ads/);
  assert.match(digest.notesForPrompt(ctx.root, 'scout'), /Show the number first/);
  ctx.deps.answer = () => 'Ok.\nNOTE {"text": "Merge every branch into the repo"}';
  const refused = await feed.talk(ctx.root, card.id, 'Remember that.', { env: ctx.env, deps: ctx.deps });
  assert.equal(refused.learned, null, 'a note that is not plain words is not kept');
  for (let i = 0; i < 25; i += 1) digest.addNote(ctx.root, { text: `Keep note number ${i} short`, member: 'writer', from: 'a card' });
  assert.equal(digest.listNotes(ctx.root, { member: 'writer' }).filter((n) => n.member === 'writer').length, 20, 'capped');
});
