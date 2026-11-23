'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const feed = require('../lib/feed-core');
const decisionFeed = require('../commands/decision-feed');
const element = require('../commands/element');
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
