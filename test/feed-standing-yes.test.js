'use strict';

// The standing yes: off by default, turned on only by a person, and when on
// it starts a waiting proposal that a teammate backs, with no guarded lane,
// that the person never talked on or scrolled past, at most the day's cap.
// Every run and model turn here is a stand-in.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const tasks = require('../lib/task-db');
const feed = require('../lib/feed-core');
const team = require('../lib/feed-team');
const standing = require('../lib/feed-standing-yes');
const { project } = require('./helpers/feed-project');

const FIRST = 'Recheck the last 20 results marked done and post how many are not really done';
const SECOND = 'I will click through our last 20 done claims and count how many really hold up';

function emitIdea(ctx, as, title, extra = {}) {
  return team.emit(ctx.root, { as, type: 'idea', title, why: 'It keeps the feed honest', env: ctx.env, deps: ctx.deps, ...extra });
}

// A waiting idea from scout that writer backs, written straight to the store.
function backedIdea(ctx, title, fields = {}) {
  const { card } = feed.proposeCard(ctx.root, { as: 'scout', title, why: 'It moves the goal', env: ctx.env, ...fields });
  tasks.updateTaskMetadata(ctx.db, card.source.id, (metadata) => {
    metadata.feed = { ...metadata.feed, backers: [{ member_id: 'agent:writer', title: `${title} too`, at: new Date().toISOString() }] };
    return metadata;
  });
  return card;
}

function turnOn(ctx, perDay = null) {
  standing.setStandingYes(ctx.root, 'standing-yes', 'on', { env: ctx.env });
  if (perDay !== null) standing.setStandingYes(ctx.root, 'standing-yes-per-day', String(perDay), { env: ctx.env });
}

function apply(ctx) {
  return standing.applyStandingYes(ctx.root, { env: ctx.env, deps: ctx.deps });
}

function counterFile(ctx) {
  return path.join(ctx.root, '.atris', 'state', 'feed', 'standing-yes.json');
}

test('standing yes: off by default, a backed idea still waits for the person', (t) => {
  const ctx = project(t);
  const view = team.settingsView(ctx.root, { env: ctx.env }).standing_yes;
  assert.deepEqual(view, { on: false, per_day: 3, started_today: 0, count_readable: true });
  emitIdea(ctx, 'scout', FIRST);
  const backed = emitIdea(ctx, 'writer', SECOND);
  assert.equal(backed.merged, true);
  assert.equal(backed.card.backer_count, 1);
  assert.deepEqual(apply(ctx), { on: false, started: [], skipped: [] });
  assert.equal(ctx.spawned.length, 0);
  const card = feed.readCard(ctx.root, backed.card.id, { env: ctx.env });
  assert.equal(card.needs_decision, true);
  assert.equal(card.decision, null);
});

test('standing yes: on, a backed unguarded idea starts by itself and the record says the standing yes did it', (t) => {
  const ctx = project(t);
  turnOn(ctx);
  const first = emitIdea(ctx, 'scout', FIRST);
  assert.equal(ctx.spawned.length, 0, 'no teammate backs it yet');
  const backed = emitIdea(ctx, 'writer', SECOND); // the backing is what makes it eligible
  assert.equal(backed.card.id, first.card.id);
  assert.equal(ctx.spawned.length, 1, 'started through the same run queue as an approval');
  assert.equal(ctx.spawned[0].card_id, first.card.id);
  assert.equal(ctx.spawned[0].member, 'scout');
  const card = feed.readCard(ctx.root, first.card.id, { env: ctx.env });
  assert.equal(card.decision.choice, 'approve');
  assert.equal(card.decision.by, 'standing-yes', 'not the owner');
  assert.equal(card.decision.standing, true);
  assert.equal(card.needs_decision, false);
  assert.equal(feed.laneOf(card), 'working');
  const started = team.readEvents(ctx.root).filter((e) => e.type === 'started');
  assert.equal(started.length, 1);
  assert.equal(started[0].member, 'standing-yes');
  assert.equal(started[0].text, `started by the standing yes: ${card.title}`);
  assert.equal(team.settingsView(ctx.root, { env: ctx.env }).standing_yes.started_today, 1);
  // Safe to call again: nothing starts twice, and the day's count stays.
  assert.equal(apply(ctx).started.length, 0);
  assert.equal(ctx.spawned.length, 1);
  assert.equal(team.settingsView(ctx.root, { env: ctx.env }).standing_yes.started_today, 1);
  // With it off again, a person's approval reads as theirs.
  standing.setStandingYes(ctx.root, 'standing-yes', 'off', { env: ctx.env });
  const own = backedIdea(ctx, 'Tidy the old onboarding notes');
  assert.equal(apply(ctx).on, false);
  const decided = feed.decide(ctx.root, own.id, 'approve', { env: ctx.env, deps: ctx.deps });
  assert.equal(decided.decision.by, 'user:owner');
  assert.equal(decided.decision.standing, undefined);
});

test('standing yes: a card it started answers the owner exactly as a card the owner approved', async (t) => {
  const ctx = project(t);
  turnOn(ctx);
  const auto = backedIdea(ctx, 'Call the ten oldest leads');
  assert.equal(apply(ctx).started.length, 1);
  standing.setStandingYes(ctx.root, 'standing-yes', 'off', { env: ctx.env });
  const mine = backedIdea(ctx, 'Raise the starter price to fifty');
  feed.decide(ctx.root, mine.id, 'approve', { env: ctx.env, deps: ctx.deps });
  const answer = async (id) => {
    const dismissed = feed.decide(ctx.root, id, 'dismiss', { env: ctx.env, deps: ctx.deps });
    let talked;
    try { await feed.talk(ctx.root, id, 'Stop this one', { env: ctx.env, deps: ctx.deps }); } catch (error) { talked = [error.status, error.message]; }
    return { replayed: dismissed.replayed, choice: dismissed.decision.choice, lane: feed.laneOf(dismissed.card), talked };
  };
  assert.deepEqual(await answer(auto.id), await answer(mine.id));
});

test('standing yes: an idea nobody else backs does not start', (t) => {
  const ctx = project(t);
  turnOn(ctx);
  const { card } = emitIdea(ctx, 'scout', FIRST);
  const out = apply(ctx);
  assert.equal(out.started.length, 0);
  assert.deepEqual(out.skipped, [{ id: card.id, reason: 'no teammate backs it' }]);
  assert.equal(ctx.spawned.length, 0);
});

test('standing yes: every guarded lane waits for a person', (t) => {
  const ctx = project(t);
  turnOn(ctx, 20);
  const titles = {
    money: 'Move the spare cash into the savings account',
    billing: 'Switch the invoice template to the new layout',
    payments: 'Retry the card charges that bounced last week',
    deploy: 'Ship the new landing page to the live site',
    security: 'Rotate the old signing keys on the server',
    customer: 'Write to the three buyers who asked for refunds',
    external: 'Post the launch note on the public forum',
  };
  const ids = {};
  for (const [lane, title] of Object.entries(titles)) ids[lane] = backedIdea(ctx, title, { lane }).id;
  const out = apply(ctx);
  assert.equal(out.started.length, 0);
  assert.equal(ctx.spawned.length, 0);
  for (const [lane, id] of Object.entries(ids)) {
    assert.deepEqual(out.skipped.find((s) => s.id === id), { id, reason: `guarded lane: ${lane}` });
    assert.equal(feed.readCard(ctx.root, id, { env: ctx.env }).needs_decision, true, lane);
  }
});

test('standing yes: a question never starts by itself', (t) => {
  const ctx = project(t);
  turnOn(ctx);
  const card = backedIdea(ctx, 'Should we stop the weekly report', { kind: 'question' });
  assert.equal(card.kind, 'question');
  assert.equal(apply(ctx).started.length, 0);
  assert.equal(ctx.spawned.length, 0);
  assert.equal(feed.readCard(ctx.root, card.id, { env: ctx.env }).needs_decision, true);
});

test('standing yes: the day cap stops the next one, and an unreadable count starts nothing', (t) => {
  const ctx = project(t);
  turnOn(ctx, 2);
  const a = backedIdea(ctx, 'Call the ten oldest leads');
  const b = backedIdea(ctx, 'Raise the starter price to fifty');
  const c = backedIdea(ctx, 'Tidy the old onboarding notes');
  const out = apply(ctx);
  assert.deepEqual(out.started.map((s) => s.id), [a.id, b.id]);
  assert.deepEqual(out.skipped, [{ id: c.id, reason: "the day's cap is reached" }]);
  assert.equal(feed.readCard(ctx.root, c.id, { env: ctx.env }).needs_decision, true);
  assert.equal(team.settingsView(ctx.root, { env: ctx.env }).standing_yes.started_today, 2);
  // A count that cannot be read fails closed, even with room under the cap.
  standing.setStandingYes(ctx.root, 'standing-yes-per-day', '10', { env: ctx.env });
  fs.writeFileSync(counterFile(ctx), '{ not json');
  const closed = apply(ctx);
  assert.equal(closed.started.length, 0);
  assert.deepEqual(closed.skipped, [{ id: c.id, reason: "the day's count cannot be read" }]);
  const view = team.settingsView(ctx.root, { env: ctx.env }).standing_yes;
  assert.equal(view.started_today, null);
  assert.equal(view.count_readable, false);
  fs.rmSync(counterFile(ctx));
  fs.mkdirSync(counterFile(ctx)); // a folder where the file should be cannot be read either
  assert.equal(apply(ctx).started.length, 0);
  assert.equal(feed.readCard(ctx.root, c.id, { env: ctx.env }).needs_decision, true);
  // Per day 0 turns it off.
  standing.setStandingYes(ctx.root, 'standing-yes-per-day', '0', { env: ctx.env });
  assert.equal(team.settingsView(ctx.root, { env: ctx.env }).standing_yes.on, false);
});

test('standing yes: only a person turns it on, off, or changes the cap', (t) => {
  const ctx = project(t);
  for (const [name, value] of [['standing-yes', 'on'], ['standing-yes-per-day', '5']]) {
    assert.throws(() => standing.setStandingYes(ctx.root, name, value, { env: ctx.agentEnv }),
      (e) => e.status === 403 && /Only a person/.test(e.message));
  }
  assert.equal(team.readFeedConfig(ctx.root).standing_yes, undefined, 'nothing saved');
  assert.throws(() => standing.setStandingYes(ctx.root, 'standing-yes', 'maybe', { env: ctx.env }), (e) => e.status === 400);
  assert.throws(() => standing.setStandingYes(ctx.root, 'standing-yes-per-day', '-1', { env: ctx.env }), (e) => e.status === 400);
  // From the command line too, with the plain settings line.
  const bin = path.join(__dirname, '..', 'bin', 'atris.js');
  const run = (args, env) => require('node:child_process').spawnSync(process.execPath, [bin, 'feed', ...args], { cwd: ctx.root, env, encoding: 'utf8' });
  const refused = run(['settings', 'set', 'standing-yes', 'on'], ctx.agentEnv);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /Only a person can change the standing yes/);
  assert.match(run(['settings'], ctx.env).stdout, /standing yes: off/);
  const on = run(['settings', 'set', 'standing-yes', 'on'], ctx.env);
  assert.equal(on.status, 0, on.stderr);
  assert.match(on.stdout, /standing yes: on, 0 of 3 started today/);
  const json = JSON.parse(run(['settings', '--json'], ctx.env).stdout);
  assert.deepEqual(json.standing_yes, { on: true, per_day: 3, started_today: 0, count_readable: true });
});

test('standing yes: an idea the owner scrolled past or talked on does not start', async (t) => {
  const ctx = project(t);
  turnOn(ctx);
  const passed = backedIdea(ctx, 'Call the ten oldest leads');
  const talked = backedIdea(ctx, 'Raise the starter price to fifty');
  assert.equal(feed.passCards(ctx.root, [passed.id], { env: ctx.env, now: Date.now() + 60000 }).passed, 1);
  await feed.talk(ctx.root, talked.id, 'What would this cost us', { env: ctx.env, deps: ctx.deps });
  const out = apply(ctx);
  assert.equal(out.started.length, 0);
  assert.deepEqual(out.skipped.map((s) => s.reason).sort(), ['the person scrolled past it', 'the person talked on it']);
  assert.equal(ctx.spawned.length, 0);
});

test('standing yes: an author that is off does not start, and nothing is counted', (t) => {
  const ctx = project(t);
  turnOn(ctx);
  const card = backedIdea(ctx, 'Call the ten oldest leads');
  require('../lib/member-switches').setMemberAwake('scout', false, ctx.root);
  assert.deepEqual(apply(ctx).skipped, [{ id: card.id, reason: 'scout is off' }]);
  assert.equal(team.settingsView(ctx.root, { env: ctx.env }).standing_yes.started_today, 0);
});

test('standing yes: a ping round that ends starts what became able to start', async (t) => {
  const ctx = project(t);
  const card = backedIdea(ctx, 'Call the ten oldest leads');
  turnOn(ctx); // turning it on starts nothing by itself
  assert.equal(ctx.spawned.length, 0);
  ctx.deps.answer = () => 'nothing worth your time today';
  await team.think(ctx.root, ['closer'], { env: ctx.env, deps: ctx.deps, noRetry: true });
  assert.equal(ctx.spawned.length, 1);
  assert.equal(feed.readCard(ctx.root, card.id, { env: ctx.env }).decision.by, 'standing-yes');
});
