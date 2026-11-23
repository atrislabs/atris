'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const feed = require('../lib/feed-core');
const room = require('../lib/feed-room');
const decisionFeed = require('../commands/decision-feed');
const element = require('../commands/element');
const ops = require('../lib/element-ops');
const { knownCommands } = require('../lib/known-commands');
const { project } = require('./helpers/feed-project');

const BIN = path.resolve(__dirname, '..', 'bin', 'atris.js');

function captureRun(args, opts) {
  const logs = [];
  const orig = console.log;
  console.log = (...parts) => logs.push(parts.join(' '));
  return Promise.resolve()
    .then(() => element.run(args, opts))
    .finally(() => { console.log = orig; })
    .then((code) => ({ code, stdout: logs.join('\n') }));
}

test('element is registered in knownCommands', () => {
  assert.ok(knownCommands.includes('element'));
});

test('decision-feed route ignores VALUE_FLAGS values like --limit 3', () => {
  assert.equal(decisionFeed.route(['--json', '--limit', '3'], { isTTY: false }).decision, true);
  assert.equal(decisionFeed.route(['--limit', '5'], { isTTY: true }).decision, true);
  assert.equal(decisionFeed.route(['--filter', 'needs_decision', '--json'], { isTTY: false }).decision, true);
  assert.equal(decisionFeed.route(['list', '5'], { isTTY: false }).decision, false);
});

test('atris element shows the single top focus card headlessly and supports yes/no/pass without an id', async (t) => {
  const ctx = project(t);
  const first = feed.proposeCard(ctx.root, {
    as: 'scout',
    title: 'Call the five oldest leads',
    why: 'Old leads reply at double the rate',
    env: ctx.env,
  });
  const second = feed.proposeCard(ctx.root, {
    as: 'scout',
    title: 'Refresh the pricing table',
    why: 'Buyers ask for annual numbers',
    env: ctx.env,
  });

  // Headless JSON focus view picks one decision card and reports remaining queue.
  const view = await captureRun(['--json'], { cwd: ctx.root, env: ctx.env });
  assert.equal(view.code, 0);
  const parsed = JSON.parse(view.stdout);
  assert.ok(parsed.focus, 'expected one focus card');
  assert.equal(parsed.focus.needs_decision, true);
  assert.ok([first.card.id, second.card.id].includes(parsed.focus.id));
  assert.equal(parsed.remaining, 1);

  // `element no` without a card id dismisses the current focus card.
  const topId = parsed.focus.id;
  const dismiss = await captureRun(['no', '--json'], { cwd: ctx.root, env: ctx.env });
  assert.equal(dismiss.code, 0);
  const dismissedOut = JSON.parse(dismiss.stdout);
  assert.deepEqual(dismissedOut.dismissed, [topId]);

  // Next focus view now points to the remaining decision card.
  const nextView = await captureRun(['next', '--json'], { cwd: ctx.root, env: ctx.env });
  assert.equal(nextView.code, 0);
  const nextParsed = JSON.parse(nextView.stdout);
  assert.ok(nextParsed.focus);
  assert.notEqual(nextParsed.focus.id, topId);
  assert.equal(nextParsed.remaining, 0);

  // `element yes` approves the remaining card without needing its id.
  const approve = await captureRun(['yes', '--json'], {
    cwd: ctx.root,
    env: ctx.env,
    deps: { startRun: () => ({ started: true, run_id: 'sim-run-1' }) },
  });
  assert.equal(approve.code, 0);
  const approvedOut = JSON.parse(approve.stdout);
  assert.equal(approvedOut.decision.choice, 'approve');
  assert.equal(approvedOut.card.id, nextParsed.focus.id);
});

test('atris element runs cleanly as a real non-TTY CLI process', (t) => {
  const ctx = project(t);
  const out = execFileSync(process.execPath, [BIN, 'element', '--json'], {
    cwd: ctx.root,
    env: { ...process.env, ...ctx.env },
    encoding: 'utf8',
  });
  const parsed = JSON.parse(out);
  assert.equal(parsed.focus, null);
  assert.equal(parsed.remaining, 0);
  assert.ok(Array.isArray(parsed.actions));
});

test('element post supports idempotent --id retries and --id-only output', async (t) => {
  const ctx = project(t);
  const first = await captureRun(['post', 'Deploy checked and green', '--id', 'deploy-sha-1', '--id-only'], {
    cwd: ctx.root,
    env: ctx.env,
  });
  assert.equal(first.code, 0);
  const cardId = first.stdout.trim();
  assert.ok(cardId.length > 0);

  const retry = await captureRun(['post', 'Deploy checked and green', '--id', 'deploy-sha-1', '--json'], {
    cwd: ctx.root,
    env: ctx.env,
  });
  assert.equal(retry.code, 0);
  const parsed = JSON.parse(retry.stdout);
  assert.equal(parsed.replayed, true);
  assert.equal(parsed.card_id, cardId);
});

test('element wait returns immediately when a reply already landed after --after (race-free)', async (t) => {
  const ctx = project(t);
  const posted = ops.postIdempotent(ctx.root, { text: 'Need a quick answer on pricing', env: ctx.env });
  const r1 = room.reply(ctx.root, posted.card_id, 'First thought', { env: ctx.env });
  const r2 = room.reply(ctx.root, posted.card_id, 'Second thought wins', { env: ctx.env });

  const waited = await captureRun(['wait', posted.card_id, '--after', r1.reply.id, '--timeout', '500ms', '--json'], {
    cwd: ctx.root,
    env: ctx.env,
  });
  assert.equal(waited.code, 0);
  const parsed = JSON.parse(waited.stdout);
  assert.equal(parsed.waited, true);
  assert.equal(parsed.reason, 'reply');
  assert.equal(parsed.reply.id, r2.reply.id);
  assert.equal(parsed.reply.text, 'Second thought wins');
});

test('element claim leases a card to one agent so a second agent cannot double-claim it', async (t) => {
  const ctx = project(t);
  const prop = feed.proposeCard(ctx.root, {
    as: 'scout',
    title: 'Check the billing webhook',
    why: 'Keep payment receipts accurate',
    env: ctx.env,
  });

  const first = await captureRun(['claim', '--as', 'scout', '--lease', '5m', '--json'], {
    cwd: ctx.root,
    env: ctx.env,
  });
  assert.equal(first.code, 0);
  const firstOut = JSON.parse(first.stdout);
  assert.equal(firstOut.claimed, true);
  assert.equal(firstOut.card.id, prop.card.id);
  assert.equal(firstOut.lease.holder, 'scout');

  // Second agent sees nothing claimable while the first lease is active.
  const rival = await captureRun(['claim', '--as', 'builder', '--lease', '5m', '--json'], {
    cwd: ctx.root,
    env: ctx.env,
  });
  assert.equal(rival.code, 1);
  assert.equal(JSON.parse(rival.stdout).claimed, false);
});

test('element tail emits NDJSON events and element curve computes sparkline, loss and bottleneck', async (t) => {
  const ctx = project(t);
  ops.postIdempotent(ctx.root, { text: 'Shipped headless Element', env: ctx.env });

  const tailed = await captureRun(['tail', '--limit', '10', '--json'], { cwd: ctx.root, env: ctx.env });
  assert.equal(tailed.code, 0);
  const lines = tailed.stdout.trim().split('\n').filter(Boolean);
  assert.ok(lines.length >= 1);
  assert.doesNotThrow(() => JSON.parse(lines[0]));

  const epFile = path.join(ctx.root, 'episodes.jsonl');
  const rows = [0.0, 0.2, 0.6, 0.8, 1.0, 1.0].map((v, i) => ({
    episode_id: `ep-${i}`,
    ts: `2026-11-20T00:0${i}:00Z`,
    action: { dispatched: i % 2 === 0, budget_reserved_usd: i % 2 === 0 ? 2.0 : 0.0 },
    reward: { value: v },
    timings_ms: { observe_ms: 80 + i * 5, gates_ms: 2, total_ms: 90 + i * 5 },
  }));
  fs.writeFileSync(epFile, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);

  const curved = await captureRun(['curve', '--file', 'episodes.jsonl', '--window', '3', '--json'], {
    cwd: ctx.root,
    env: ctx.env,
  });
  assert.equal(curved.code, 0);
  const out = JSON.parse(curved.stdout);
  assert.equal(out.summary.total_episodes, 6);
  assert.equal(out.summary.trend, 'improving');
  assert.equal(out.summary.top_bottleneck, 'observe');
  assert.equal(out.summary.total_spend_usd, 6);
  assert.ok(out.sparkline.length > 0);
});

test('a chat waiting in its own window never holds the one-card focus', async (t) => {
  const ctx = project(t);
  feed.proposeCard(ctx.root, { as: 'scout', title: 'Call the ten oldest leads', why: 'It moves the goal', env: ctx.env });
  feed.setWaiting(ctx.root, { session: 'abc123', ask: 'Which plan should I keep?', title: 'Plan review chat' });
  const out = element.focusPayload(ctx.root, { env: ctx.env });
  assert.equal(out.focus.title, 'Call the ten oldest leads', 'the card you can act on here is the focus');
  assert.deepEqual(out.chats.map((c) => c.title), ['Plan review chat']);
  const shown = await captureRun([], { cwd: ctx.root, env: ctx.env, deps: ctx.deps });
  assert.match(shown.stdout, /A chat is waiting on you in its own window:\n  Plan review chat/);
  assert.match(shown.stdout, /atris element yes/);
});
