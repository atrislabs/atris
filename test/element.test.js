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

test('element deterministic slash commands run allowlisted workflows, redact tokens, and reply into the card thread', async (t) => {
  const ctx = project(t);
  const posted = ops.postIdempotent(ctx.root, { text: 'Check this build', env: ctx.env });

  // Unregistered command is refused cleanly (allowlist-only).
  const missing = await captureRun(['run', '/not-registered', posted.card_id, '--json'], { cwd: ctx.root, env: ctx.env });
  assert.equal(missing.code, 1);
  assert.equal(JSON.parse(missing.stdout).ok, false);

  // Register a deterministic workflow and verify it runs, redacts token-shaped strings, and replies on the card.
  const added = await captureRun(
    ['cmd', 'add', 'smoke', 'printf "all green token=sk-secret1234567890"', '--description', 'Quick smoke check', '--json'],
    { cwd: ctx.root, env: ctx.env },
  );
  assert.equal(added.code, 0);
  assert.equal(JSON.parse(added.stdout).command.name, 'smoke');

  const ran = await captureRun(['run', '/smoke', posted.card_id, '--json'], { cwd: ctx.root, env: ctx.env });
  assert.equal(ran.code, 0);
  const ranOut = JSON.parse(ran.stdout);
  assert.equal(ranOut.passed, true);
  assert.ok(ranOut.receipt.includes('[redacted]'));
  assert.ok(!ranOut.receipt.includes('sk-secret1234567890'));

  const replies = room.replies(ctx.root, posted.card_id, { env: ctx.env }).replies;
  assert.ok(replies.some((r) => r.text.startsWith('/smoke passed:')));

  // Built-in /curve workflow runs with zero setup.
  const builtin = await captureRun(['run', '/curve', posted.card_id, '--json'], { cwd: ctx.root, env: ctx.env });
  assert.equal(builtin.code, 0);
  assert.equal(JSON.parse(builtin.stdout).passed, true);
});

test('element repeating message schedules fire on due clock ticks and never double-post in the same slot', async (t) => {
  const ctx = project(t);
  const t0 = '2026-11-23T12:00:00.000Z';
  const tEarly = '2026-11-23T12:30:00.000Z';
  const tDue = '2026-11-23T13:00:00.000Z';
  const tSecondSlot = '2026-11-23T14:05:00.000Z';

  const added = await captureRun(
    ['schedule', 'add', '--id', 'hourly-check', '--every', '1h', '--to', 'scout', '--now', t0, 'Check live errors and report', '--json'],
    { cwd: ctx.root, env: ctx.env },
  );
  assert.equal(added.code, 0);
  assert.equal(JSON.parse(added.stdout).schedule.next_run_at, tDue);

  // Before next_run_at nothing fires.
  const early = await captureRun(['schedule', 'tick', '--now', tEarly, '--json'], { cwd: ctx.root, env: ctx.env });
  assert.equal(early.code, 0);
  assert.equal(JSON.parse(early.stdout).count, 0);

  // At next_run_at the message posts once.
  const due = await captureRun(['schedule', 'tick', '--now', tDue, '--json'], { cwd: ctx.root, env: ctx.env });
  assert.equal(due.code, 0);
  const dueOut = JSON.parse(due.stdout);
  assert.equal(dueOut.count, 1);
  assert.equal(dueOut.fired[0].replayed, false);

  // Ticking again at the exact same time fires nothing (next_run_at advanced).
  const dup = await captureRun(['schedule', 'tick', '--now', tDue, '--json'], { cwd: ctx.root, env: ctx.env });
  assert.equal(dup.code, 0);
  assert.equal(JSON.parse(dup.stdout).count, 0);

  // Next hour threads a second run onto the schedule's card and increments run_count.
  const second = await captureRun(['schedule', 'tick', '--now', tSecondSlot, '--json'], { cwd: ctx.root, env: ctx.env });
  assert.equal(second.code, 0);
  const secondOut = JSON.parse(second.stdout);
  assert.equal(secondOut.count, 1);
  assert.equal(secondOut.fired[0].card_id, dueOut.fired[0].card_id);
  assert.equal(secondOut.fired[0].run_count, 2);
});
