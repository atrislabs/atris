'use strict';

// Endless scrolling: ON members think up ideas in one fast turn each, up to
// three at once, outside the work queue, and their cards stream in as they
// are written. Limits depend on who pays; members rotate; a member whose
// ideas keep missing rests. Every model here is a stand-in.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const feed = require('../lib/feed-core');
const team = require('../lib/feed-team');
const { setMemberAwake } = require('../lib/member-switches');
const { changed, project } = require('./helpers/feed-project');

const TWO = 'IDEA\nTITLE: Thank the first ten buyers\nWHY: Thanked buyers come back\nBODY: One short note each.\n'
  + 'VISUAL: {"kind": "steps", "steps": ["Find the ten", "Write one line each"]}\nEND\n'
  + 'QUESTION\nTITLE: Which city should we start in?\nWHY: It decides who we call first\nEND\n';

function streaming(ctx, text, { delay = 0 } = {}) {
  return async ({ onText }) => {
    for (const piece of text.match(/.{1,5}/gs) || []) {
      if (delay) await new Promise((r) => setTimeout(r, delay));
      onText(piece);
    }
    return { ok: true, text };
  };
}

async function streamPing(ctx, options = {}) {
  const events = [];
  const out = await team.pingStream(ctx.root, { reason: 'scroll', env: ctx.env, deps: ctx.deps, onEvent: (e) => events.push(e), ...options });
  return { events, out };
}

test('stream: cards come in as they are written, then pass the normal checks', async (t) => {
  const ctx = project(t, ['scout']);
  ctx.deps.turn = streaming(ctx, TWO);
  const { events } = await streamPing(ctx);
  const types = events.map((e) => e.type);
  assert.equal(types[0], 'member_started');
  assert.deepEqual(types.slice(-2), ['member_done', 'done']);
  const first = events.find((e) => e.type === 'card_started');
  const title = events.filter((e) => e.type === 'card_text' && e.temp_id === first.temp_id && e.field === 'title');
  assert.ok(title.length > 1, 'the title arrives in pieces');
  assert.equal(title.map((e) => e.chunk).join(''), 'Thank the first ten buyers');
  assert.ok(events.some((e) => e.type === 'card_text' && e.field === 'why'));
  assert.equal(events.find((e) => e.type === 'card_visual').visual.kind, 'steps');
  const done = events.filter((e) => e.type === 'card_done');
  assert.equal(done.length, 2);
  assert.equal(done[0].card.title, 'Thank the first ten buyers');
  assert.equal(done[0].card.visual.kind, 'steps');
  assert.equal(done[1].card.kind, 'question');
  assert.equal(events.find((e) => e.type === 'member_done').ideas, 2);
  assert.ok(types.indexOf('card_text') < types.indexOf('card_done'), 'words before the finished card');
});

test('stream: a card cut off mid-way, or one that fails the checks, is dropped and nothing half-made is created', async (t) => {
  const ctx = project(t, ['scout']);
  ctx.deps.turn = async ({ onText }) => {
    const text = 'IDEA\nTITLE: Merge the branch into the repo\nWHY: x\nEND\nIDEA\nTITLE: Call the warm leads today\nWHY: They answer';
    for (const piece of text.match(/.{1,6}/gs)) onText(piece);
    return { ok: false, text, error: 'the connection dropped' };
  };
  // The person asked for more: a slip gets its one rewrite. (A round the feed started by itself makes no second model call.)
  const { events } = await streamPing(ctx, { reason: 'more' });
  const dropped = events.filter((e) => e.type === 'card_dropped');
  assert.ok(dropped.some((e) => /plain words/.test(e.reason) && /One rewrite did not fix it/.test(e.reason)), 'one rewrite was tried first');
  assert.ok(dropped.some((e) => /stopped before the card was finished/.test(e.reason)));
  assert.ok(events.some((e) => e.type === 'card_rewriting'));
  assert.ok(events.some((e) => e.type === 'retry'), 'an empty round tries once more');
  assert.match(events.find((e) => e.type === 'empty').reason, /tried twice/);
  assert.equal(feed.listCards(ctx.root, { env: ctx.env }).cards.length, 0, 'nothing was created');
});

test('stream: up to three members think at once, outside the work queue', async (t) => {
  const ctx = project(t, ['scout', 'writer', 'closer', 'extra']);
  let now = 0;
  let most = 0;
  ctx.deps.turn = async ({ onText }) => {
    now += 1; most = Math.max(most, now);
    await new Promise((r) => setTimeout(r, 30));
    const text = `IDEA\nTITLE: Idea number ${now} ${Math.random().toString(36).slice(2, 6)}\nWHY: It helps\nEND\n`;
    onText(text);
    now -= 1;
    return { ok: true, text };
  };
  const { out } = await streamPing(ctx);
  assert.equal(out.pinged, 3);
  assert.equal(most, 3);
  assert.equal(feed.readRuns(ctx.root).length, 0, 'the work queue is for approved work only');
  assert.equal(ctx.spawned.length, 0);
});

test('stream: one thought in flight per member; without --stream the thinking runs in the background', (t) => {
  const ctx = project(t, ['scout', 'writer']);
  fs.mkdirSync(path.join(ctx.root, '.atris', 'state', 'feed'), { recursive: true });
  fs.writeFileSync(path.join(ctx.root, '.atris', 'state', 'feed', 'thinking-scout.json'), JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
  // One ask in flight per project: while scout still thinks, a new ask waits for it.
  const busy = team.ping(ctx.root, { reason: 'scroll', env: ctx.env, deps: ctx.deps });
  assert.equal(busy.pinged, 0);
  assert.match(busy.reason, /scout is still thinking, so new ideas are already on the way/);
  assert.match(team.ping(ctx.root, { member: 'scout', reason: 'scroll', env: ctx.env, deps: ctx.deps }).members[0].reason, /already thinking/);
  fs.rmSync(path.join(ctx.root, '.atris', 'state', 'feed', 'thinking-scout.json'));
  const out = team.ping(ctx.root, { reason: 'scroll', env: ctx.env, deps: ctx.deps });
  assert.equal(out.pinged, 2);
  assert.deepEqual(ctx.thinkers, [{ names: ['scout', 'writer'], reason: 'scroll' }], 'it answered at once and left the thinking to a background run');
});

test('limits: generous on this computer\'s models, tighter on paid ones, with a plain reason and when it resets', async (t) => {
  const ctx = project(t, ['scout', 'writer']);
  const settings = team.settingsView(ctx.root, { env: ctx.env });
  assert.deepEqual(settings.limits, { local_pings_per_day: 200, cloud_pings_per_day: 60, member_gap_seconds: 5 });
  ctx.deps.turn = streaming(ctx, 'IDEA\nTITLE: Call the warm leads today\nWHY: They answer\nEND\n');
  await streamPing(ctx, { member: 'scout' });
  // Asked a moment ago: the ask waits the seconds left, then asks, instead of refusing.
  ctx.deps.turn = streaming(ctx, 'IDEA\nTITLE: Ask the quiet buyers what they want\nWHY: They answer\nEND\n');
  const again = await streamPing(ctx, { member: 'scout' });
  assert.equal(again.out.pinged, 1);
  assert.ok(again.events.find((e) => e.type === 'thinking').wait_ms > 0);
  assert.ok(ctx.deps.sleeps[0] > 0 && ctx.deps.sleeps[0] <= 5000);
  const capped = { ...ctx.env, ATRIS_FEED_PINGS_PER_DAY: '1', ATRIS_FEED_MEMBER_GAP_SECONDS: '0' };
  const full = await streamPing(ctx, { member: 'writer', env: capped });
  assert.match(full.out.members[0].reason, /1 times today on this computer's models, the most allowed\. It resets in/);
  assert.ok(full.events.find((e) => e.type === 'member_skipped').resets_at);
  // The paid models count separately, and their credits are reported.
  fs.writeFileSync(path.join(ctx.root, 'atris', '.config'), JSON.stringify({ feed: { default_engine: 'atris-fast' } }));
  ctx.deps.turn = async ({ onText }) => { onText('IDEA\nTITLE: Write the spring price note\nWHY: Buyers ask\nEND\n'); return { ok: true, text: 'x', credits_charged: 3 }; };
  const cloud = await streamPing(ctx, { member: 'writer', env: { ...capped, ATRIS_TOKEN: 'x' } });
  assert.equal(cloud.out.pinged, 1);
  const today = team.settingsView(ctx.root, { env: ctx.env }).today;
  assert.equal(today.cloud_pings, 1);
  assert.equal(today.credits_used, 3);
  const changed = team.setLimit(ctx.root, 'local-pings-per-day', '500', { env: ctx.env });
  assert.equal(changed.limits.local_pings_per_day, 500);
  assert.throws(() => team.setLimit(ctx.root, 'nonsense', '1', { env: ctx.env }), (e) => e.status === 400);
  assert.throws(() => team.setLimit(ctx.root, 'member-gap-seconds', '5', { env: ctx.agentEnv }), (e) => e.status === 403);
});

test('variety: members rotate, ideas must be unlike what is there, and a member whose ideas keep missing rests', async (t) => {
  const ctx = project(t, ['scout', 'writer', 'closer', 'extra']);
  const env = { ...ctx.env, ATRIS_FEED_MEMBER_GAP_SECONDS: '0' };
  let n = 0;
  ctx.deps.turn = async ({ onText }) => { n += 1; const text = `IDEA\nTITLE: A fresh idea number ${n} for buyers\nWHY: It helps\nEND\n`; onText(text); return { ok: true, text }; };
  const first = await streamPing(ctx, { env });
  const asked = first.out.members.filter((m) => m.status === 'done').map((m) => m.name);
  changed(ctx);
  const second = await streamPing(ctx, { env });
  assert.equal(second.out.members.find((m) => m.status === 'done').name, ['scout', 'writer', 'closer', 'extra'].find((m) => !asked.includes(m)), 'whoever waited longest goes first');
  const prompt = team.ideaPrompt(ctx.root, 'scout', 'scroll');
  assert.match(prompt, /unlike every idea above/);
  assert.match(prompt, /A fresh idea number 1 for buyers/, 'recent titles from everyone');
  for (const label of ['said yes to these', 'said no to these', 'scrolling past these', 'What the owner said on cards']) assert.match(prompt, new RegExp(label));
  // Four misses in a row: scout rests while the others are asked.
  const fresh = project(t, ['scout', 'writer']);
  for (const title of ['Paint the shop door', 'Sing to the buyers', 'Count the clouds', 'Name the candles']) {
    const card = feed.proposeCard(fresh.root, { as: 'scout', title, why: 'Fun', env: fresh.env }).card;
    feed.decide(fresh.root, card.id, 'dismiss', { env: fresh.env, deps: fresh.deps });
  }
  fresh.deps.turn = async () => ({ ok: true, text: '' }); // nothing new, so the four misses stay the latest
  const quickEnv = { ...fresh.env, ATRIS_FEED_MEMBER_GAP_SECONDS: '0' };
  void quickEnv;
  // Four dismissals: scout is asked after the others, never left out.
  const plan = team.ping(fresh.root, { reason: 'scroll', env: fresh.env, deps: fresh.deps });
  assert.deepEqual(fresh.thinkers[0].names, ['writer', 'scout']);
  assert.equal(plan.pinged, 2);
});

test('ping: off when no member is ON; refuses agents and battery saver', async (t) => {
  const ctx = project(t, ['scout', 'writer'], { on: false });
  assert.match(team.ping(ctx.root, { env: ctx.env, deps: ctx.deps }).reason, /No team member is on/);
  setMemberAwake('scout', true, ctx.root);
  assert.throws(() => team.ping(ctx.root, { env: ctx.agentEnv, deps: ctx.deps }), (e) => e.status === 403);
  assert.match(team.ping(ctx.root, { reason: 'heartbeat', env: ctx.env, deps: { ...ctx.deps, lowPower: () => true } }).reason, /saving battery/);
  assert.equal(team.ping(ctx.root, { reason: 'scroll', env: ctx.env, deps: { ...ctx.deps, lowPower: () => true } }).pinged, 1, 'a person asking is heard even on battery saver');
  ctx.thinkers.length = 0;
  assert.match(team.ping(ctx.root, { member: 'writer', env: ctx.env, deps: ctx.deps }).reason, /writer is off/);
  assert.deepEqual(ctx.thinkers, []);
});

test('cli: atris feed ping --stream prints one JSON event per line', (t) => {
  const ctx = project(t, ['scout'], { on: false });
  const run = require('node:child_process').spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'atris.js'), 'feed', 'ping', '--reason', 'scroll', '--stream', '--json'], { cwd: ctx.root, env: ctx.env, encoding: 'utf8' });
  const lines = run.stdout.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(lines.pop().type, 'done');
});

test('copies: the same short title from two members, or a copy of an idea already approved, makes no second card', (t) => {
  const ctx = project(t, ['scout', 'writer', 'closer']);
  const first = feed.proposeCard(ctx.root, { as: 'scout', title: 'Make the candle sizes clear', why: 'Buyers ask', env: ctx.env });
  const twin = feed.proposeCard(ctx.root, { as: 'writer', title: 'Make the candle sizes clear', why: 'Buyers ask', env: ctx.env });
  assert.equal(twin.merged, true);
  assert.equal(twin.card.id, first.card.id);
  feed.decide(ctx.root, first.card.id, 'approve', { env: ctx.env, deps: ctx.deps });
  const late = feed.proposeCard(ctx.root, { as: 'closer', title: 'Make the candle sizes clear', why: 'Buyers ask', env: ctx.env });
  assert.equal(late.created, false, 'an approved idea still at work has no twin');
});

test('stream: a card the model forgot to END is still whole when the answer ended normally', async (t) => {
  const ctx = project(t, ['scout']);
  ctx.deps.turn = streaming(ctx, 'IDEA\nTITLE: Call the warm leads today\nWHY: They answer\nIDEA\nTITLE: Write the spring price note\nWHY: Buyers ask\n');
  const { events } = await streamPing(ctx);
  assert.equal(events.filter((e) => e.type === 'card_done').length, 2);
  assert.equal(events.filter((e) => e.type === 'card_dropped').length, 0);
});

test('found: at the end of the feed with many ideas waiting (most held back), a change in the project still brings the team in', async (t) => {
  const ctx = project(t, ['scout', 'writer', 'closer', 'extra']);
  const titles = ['Call the warm leads today', 'Write the spring price note', 'Ask three owners for a quote', 'Thank the first ten buyers',
    'Check every price on the shop page', 'Send a short welcome note', 'Fix the opening hours line', 'Add a photo to the soap page', 'Answer the oldest customer email'];
  const ids = titles.map((title, i) => feed.proposeCard(ctx.root, { as: ['scout', 'writer', 'closer', 'extra'][i % 4], title, why: 'More people buy', env: ctx.env }).card.id);
  feed.passCards(ctx.root, ids.slice(0, 8), { env: ctx.env, now: Date.now() + 11000 });
  const more = feed.requestMoreIdeas(ctx.root, { env: ctx.env, deps: ctx.deps });
  assert.equal(more.requested, 3, more.reason);
  changed(ctx);
  const scroll = team.ping(ctx.root, { reason: 'scroll', env: { ...ctx.env }, deps: ctx.deps });
  assert.equal(scroll.pinged, 1, 'the members asked a moment ago are passed over, the one left is asked');
  const askedFirst = more.members.filter((m) => m.status === 'started').map((m) => m.name);
  assert.equal(scroll.members.find((m) => m.status === 'started').name, ['scout', 'writer', 'closer', 'extra'].find((m) => !askedFirst.includes(m)));
  // Only the automatic heartbeat rests while plenty wait.
  changed(ctx);
  const beat = team.ping(ctx.root, { reason: 'heartbeat', env: { ...ctx.env, ATRIS_FEED_MEMBER_GAP_SECONDS: '0' }, deps: ctx.deps });
  assert.equal(beat.pinged, 0);
  assert.match(beat.reason, /9 ideas are already waiting, so the heartbeat lets the team rest/);
});

test('found: asks recorded by the earlier feed still count toward the day, so the ready check never reads zero', async (t) => {
  const ctx = project(t, ['scout']);
  const file = path.join(ctx.root, '.atris', 'state', 'feed', 'pings.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ day: new Date().toISOString().slice(0, 10), total: 8, members: { scout: { count: 2, last_at: new Date(0).toISOString() } } }));
  assert.equal(team.settingsView(ctx.root, { env: ctx.env }).today.local_pings, 8);
  const out = await team.doctor(ctx.root, { env: ctx.env, deps: ctx.deps, call: false });
  assert.match(out.checks.find((c) => c.name === 'caps').detail, /Asked for ideas today: 8 of 200/);
  team.ping(ctx.root, { reason: 'event', env: ctx.env, deps: ctx.deps }); // an ask when members wake counts too
  assert.equal(team.settingsView(ctx.root, { env: ctx.env }).today.local_pings, 9);
});

test('found: with few ideas on screen, a passed idea comes back after 5 minutes, after the newer ones', (t) => {
  const ctx = project(t, ['scout', 'writer']);
  const old = feed.proposeCard(ctx.root, { as: 'scout', title: 'Call the warm leads today', why: 'They answer', env: ctx.env }).card;
  const fresh = feed.proposeCard(ctx.root, { as: 'writer', title: 'Write the spring price note', why: 'Buyers ask', env: ctx.env }).card;
  feed.passCards(ctx.root, [old.id], { env: ctx.env, now: Date.now() + 11000 });
  const back = (minutes) => require('../lib/task-db').updateTaskMetadata(ctx.db, old.source.id, (m) => {
    for (const entry of Object.values(m.feed_views[old.id])) entry.last_passed_at = new Date(Date.now() - minutes * 60000).toISOString();
    return m;
  }, { touch: false });
  const shown = () => feed.listCards(ctx.root, { env: ctx.env }).cards.map((card) => card.id);
  back(2);
  assert.deepEqual(shown(), [fresh.id], 'two minutes is too soon');
  back(6);
  assert.deepEqual(shown(), [fresh.id, old.id], 'back after five minutes, after the newer idea');
});

test('refusals: a day limit says so plainly with the reset time, in the answer and in the stream', async (t) => {
  const ctx = project(t, ['scout']);
  const env = { ...ctx.env, ATRIS_FEED_PINGS_PER_DAY: '0' };
  const out = team.ping(ctx.root, { reason: 'scroll', env, deps: ctx.deps });
  assert.equal(out.pinged, 0);
  assert.match(out.reason, /the most allowed\. It resets in/);
  assert.ok(Date.parse(out.resets_at) > Date.now());
  const events = [];
  await team.pingStream(ctx.root, { reason: 'scroll', env, deps: ctx.deps, onEvent: (e) => events.push(e) });
  const done = events.find((e) => e.type === 'done');
  assert.match(done.reason, /It resets in/);
  assert.ok(done.resets_at);
});
