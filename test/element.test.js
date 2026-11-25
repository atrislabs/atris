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

// A helper from outside (Codex here) joins, takes a task a teammate tagged it on, reports on the same card,
// hands in a checked result and leaves a lesson. The receipt reads the whole chain back from what was saved.
test('element: an outside helper connects, claims a tagged task with a handoff, reports, finishes and leaves a receipt', async (t) => {
  const ctx = project(t);
  const o = { cwd: ctx.root, env: ctx.agentEnv, deps: ctx.deps };
  fs.writeFileSync(path.join(ctx.root, 'atris', 'lessons.md'), '# Lessons\n\n- Check the title on a phone before saving\n');

  const joined = await captureRun(['connect', '--as', 'codex', '--json'], o);
  assert.equal(joined.code, 0);
  const seat = JSON.parse(joined.stdout);
  assert.equal(seat.outside, true);
  assert.equal(seat.on, true);
  assert.deepEqual(seat.context.lessons, ['Check the title on a phone before saving']);
  assert.ok(fs.existsSync(path.join(ctx.root, 'atris', 'team', 'codex', 'MEMBER.md')));

  const posted = await captureRun(['task', 'Fix the typo in the readme title', '--as', 'scout', '--to', 'codex', '--detail', 'README.md line 1: "Atirs" should be "Atris"', '--id', 'typo-1', '--json'], o);
  assert.equal(posted.code, 0);
  const task = JSON.parse(posted.stdout);
  assert.equal(task.owner, 'codex');
  assert.equal(task.posted_by, 'agent:scout');
  // The same key never makes a second card.
  const again = JSON.parse((await captureRun(['task', 'Fix the typo in the readme title', '--as', 'scout', '--to', 'codex', '--id', 'typo-1', '--json'], o)).stdout);
  assert.equal(again.replayed, true);
  assert.equal(again.card_id, task.card_id);

  // connect now shows the card waiting for this helper.
  const back = JSON.parse((await captureRun(['connect', '--as', 'codex', '--json'], o)).stdout);
  assert.equal(back.created, false);
  assert.deepEqual(back.context.yours.map((line) => line.card), [task.card_id]);

  const claimed = await captureRun(['claim', '--as', 'codex', '--json'], o);
  assert.equal(claimed.code, 0);
  const mine = JSON.parse(claimed.stdout);
  assert.equal(mine.card.id, task.card_id);
  assert.equal(mine.owner, 'codex');
  assert.equal(mine.card.state, 'working');
  assert.equal(mine.handoff.task.asked_by, 'agent:scout');
  assert.equal(mine.handoff.task.detail, 'README.md line 1: "Atirs" should be "Atris"');
  assert.ok(mine.handoff.lessons.includes('Check the title on a phone before saving'));
  assert.match(mine.handoff.report_with.complete, /element complete/);

  // Nobody else can take it or report on it while the hold is live.
  const rival = await captureRun(['claim', task.card_id, '--as', 'writer', '--json'], o);
  assert.equal(rival.code, 1);
  assert.match(JSON.parse(rival.stdout).error.message, /codex holds this card/);
  const stranger = await captureRun(['progress', task.card_id, '--as', 'writer', 'Looking at it too', '--json'], o);
  assert.equal(stranger.code, 1);

  assert.equal((await captureRun(['progress', task.card_id, '--as', 'codex', 'Found the typo on line one'], o)).code, 0);

  // A check that fails means no result: the card is still being worked.
  const failed = await captureRun(['complete', task.card_id, '--as', 'codex', '--proof', 'ran the check', '--verify', 'exit 3', '--json'], o);
  assert.equal(failed.code, 1);
  assert.match(JSON.parse(failed.stdout).error.message, /check did not pass \(exit 3\)/);
  const midway = JSON.parse((await captureRun(['receipt', task.card_id, '--json'], o)).stdout);
  assert.equal(midway.complete, false);
  assert.equal(midway.steps.result, false);

  const done = await captureRun([
    'complete', task.card_id, '--as', 'codex', '--proof', 'ran the readme check and it passed', '--verify', 'exit 0',
    '--lesson', 'Read the title aloud before saving', 'Fixed the title', '--json',
  ], o);
  assert.equal(done.code, 0);
  assert.equal(JSON.parse(done.stdout).check.passed, true);

  const proofOut = await captureRun(['receipt', task.card_id, '--json'], o);
  assert.equal(proofOut.code, 0);
  const receipt = JSON.parse(proofOut.stdout);
  assert.equal(receipt.complete, true);
  assert.deepEqual(receipt.steps, { posted: true, handoff: true, owner: true, result: true, checked: true, lesson: true });
  assert.equal(receipt.owner, 'codex');
  assert.equal(receipt.owner_outside, true);
  assert.equal(receipt.posted_by, 'agent:scout');
  assert.equal(receipt.state, 'waiting for the owner to accept');
  assert.deepEqual(receipt.progress.map((p) => p.text), ['Found the typo on line one']);
  assert.equal(receipt.proof, 'ran the readme check and it passed');
  assert.match(fs.readFileSync(path.join(ctx.root, 'atris', 'team', 'codex', 'lessons.md'), 'utf8'), /- Read the title aloud before saving \(from "Fix the typo in the readme title"/);

  // The finished work is in front of the owner to accept, and no run was started on the owner's models.
  const ownerView = JSON.parse((await captureRun(['--json'], { cwd: ctx.root, env: ctx.env })).stdout);
  assert.equal(ownerView.counts.needs_decision, 1);
  assert.equal(ctx.spawned.length, 0);
  assert.equal(ctx.turns.length, 0);

  // The lesson is handed to the next helper that takes a card here.
  const next = JSON.parse((await captureRun(['task', 'Check the footer year', '--as', 'scout', '--to', 'codex', '--json'], o)).stdout);
  const second = JSON.parse((await captureRun(['claim', next.card_id, '--as', 'codex', '--json'], o)).stdout);
  assert.ok(second.handoff.lessons.some((line) => line.startsWith('Read the title aloud before saving')));
});

test('element claim keeps what is the owner\'s: ideas, protected work, another helper\'s tag and a seat switched off', async (t) => {
  const ctx = project(t);
  const o = { cwd: ctx.root, env: ctx.agentEnv, deps: ctx.deps };
  await captureRun(['connect', '--as', 'codex', '--json'], o);
  await captureRun(['connect', '--as', 'devin', '--json'], o);

  // An idea the team thought up still waits for the owner's yes.
  const idea = feed.proposeCard(ctx.root, { as: 'codex', title: 'Check the billing webhook', why: 'Keep payment receipts accurate', env: ctx.agentEnv });
  const early = await captureRun(['claim', idea.card.id, '--as', 'codex', '--json'], o);
  assert.equal(early.code, 1);
  assert.match(JSON.parse(early.stdout).error.message, /waits for the owner's yes/);
  // The owner's yes hands it to the outside helper without starting anything on this computer.
  const yes = feed.decide(ctx.root, idea.card.id, 'approve', { env: ctx.env, deps: ctx.deps });
  assert.equal(yes.outcome.started, false);
  assert.equal(yes.outcome.reason, 'waits_for_outside_helper');
  assert.equal(ctx.spawned.length, 0);
  assert.equal((await captureRun(['claim', idea.card.id, '--as', 'codex', '--json'], o)).code, 0);

  // Protected work waits for the owner even when a teammate posts it as a task.
  const money = JSON.parse((await captureRun(['task', 'Refund the last three orders', '--as', 'scout', '--to', 'codex', '--lane', 'money', '--json'], o)).stdout);
  const held = await captureRun(['claim', money.card_id, '--as', 'codex', '--json'], o);
  assert.equal(held.code, 1);
  assert.match(JSON.parse(held.stdout).error.message, /money work, so it waits for the owner's yes/);

  // A task tagged to one helper is not another's to take.
  const tagged = JSON.parse((await captureRun(['task', 'Tidy the changelog headings', '--as', 'scout', '--to', 'devin', '--json'], o)).stdout);
  const wrong = await captureRun(['claim', tagged.card_id, '--as', 'codex', '--json'], o);
  assert.equal(wrong.code, 1);
  assert.match(JSON.parse(wrong.stdout).error.message, /tagged to devin/);
  // With no card named, a helper only ever gets work it may take: here, nothing.
  const none = await captureRun(['claim', '--as', 'writer', '--json'], o);
  assert.equal(none.code, 1);
  assert.equal(JSON.parse(none.stdout).claimed, false);

  // The owner can make a teammate's task wait for their yes too.
  fs.writeFileSync(path.join(ctx.root, 'atris', '.config'), JSON.stringify({ feed: { default_engine: 'codex', agent_tasks: 'off' } }));
  const waits = await captureRun(['claim', tagged.card_id, '--as', 'devin', '--json'], o);
  assert.equal(waits.code, 1);
  assert.match(JSON.parse(waits.stdout).error.message, /waits for their yes/);
  fs.writeFileSync(path.join(ctx.root, 'atris', '.config'), JSON.stringify({ feed: { default_engine: 'codex' } }));

  // A seat the owner switched off takes nothing, posts nothing, and connect does not switch it back on.
  require('../lib/member-switches').setMemberAwake('devin', false, ctx.root);
  const mute = await captureRun(['task', 'Sort the footer links', '--as', 'devin', '--to', 'codex', '--json'], o);
  assert.equal(mute.code, 1);
  assert.match(JSON.parse(mute.stdout).error.message, /devin is off, so it cannot post a task/);
  const off = await captureRun(['claim', tagged.card_id, '--as', 'devin', '--json'], o);
  assert.equal(off.code, 1);
  assert.match(JSON.parse(off.stdout).error.message, /devin is off/);
  const rejoin = await captureRun(['connect', '--as', 'devin', '--json'], o);
  assert.equal(rejoin.code, 1);
  assert.equal(JSON.parse(rejoin.stdout).on, false);
});

test('element: a person\'s task for an outside helper is ready to claim, and a hold that ran out lets the next helper take over', async (t) => {
  const ctx = project(t);
  const agent = { cwd: ctx.root, env: ctx.agentEnv, deps: ctx.deps };
  const person = { cwd: ctx.root, env: ctx.env, deps: ctx.deps };
  await captureRun(['connect', '--as', 'codex', '--json'], agent);
  await captureRun(['connect', '--as', 'devin', '--json'], agent);

  // An agent has to say who it is.
  const nameless = await captureRun(['task', 'Sort the glossary by letter', '--json'], agent);
  assert.equal(nameless.code, 1);

  // No tag: the task goes to the seat whose role fits its words.
  fs.writeFileSync(path.join(ctx.root, 'atris', 'team', 'writer', 'MEMBER.md'), '---\nname: writer\nrole: Writes the glossary and help pages\n---\n# writer\n');
  const routed = JSON.parse((await captureRun(['task', 'Sort the glossary by letter', '--as', 'scout', '--json'], agent)).stdout);
  assert.equal(routed.owner, 'writer');

  const posted = JSON.parse((await captureRun(['task', 'Add the missing alt text on the pricing page', '--to', 'codex', '--json'], person)).stdout);
  assert.equal(posted.posted_by, 'user:owner');
  assert.equal(ctx.spawned.length, 0);

  const first = JSON.parse((await captureRun(['claim', posted.card_id, '--as', 'codex', '--lease', '1s', '--json'], agent)).stdout);
  assert.equal(first.owner, 'codex');
  // The tag was the person's, so another helper cannot take it while it is held or after.
  const leases = path.join(ctx.root, '.atris', 'state', 'feed', 'leases.json');
  const saved = JSON.parse(fs.readFileSync(leases, 'utf8'));
  saved[posted.card_id].expires_at_ms = Date.now() - 1000;
  fs.writeFileSync(leases, JSON.stringify(saved));
  const blocked = await captureRun(['claim', posted.card_id, '--as', 'devin', '--json'], agent);
  assert.equal(blocked.code, 1);
  assert.match(JSON.parse(blocked.stdout).error.message, /tagged to codex/);

  // An untagged task whose helper went quiet past its hold goes to the next one, and the first can no longer finish it.
  const open = JSON.parse((await captureRun(['task', 'Refresh the screenshot on the help page', '--as', 'codex', '--json'], agent)).stdout);
  const db = require('../lib/task-db');
  db.updateTaskMetadata(ctx.db, open.card_id.split(':')[1], (metadata) => { metadata.feed.task.tagged = false; metadata.feed.task.to = ''; return metadata; });
  assert.equal((await captureRun(['claim', open.card_id, '--as', 'codex', '--json'], agent)).code, 0);
  const held = JSON.parse(fs.readFileSync(leases, 'utf8'));
  held[open.card_id].expires_at_ms = Date.now() - 1000;
  fs.writeFileSync(leases, JSON.stringify(held));
  const taken = JSON.parse((await captureRun(['claim', open.card_id, '--as', 'devin', '--json'], agent)).stdout);
  assert.equal(taken.owner, 'devin');
  const late = await captureRun(['complete', open.card_id, '--as', 'codex', '--proof', 'ran it', '--json'], agent);
  assert.equal(late.code, 1);
  assert.match(JSON.parse(late.stdout).error.message, /codex is not the one doing this work/);
});

test('element questions wait for a person, preserve the hold and keep their history', async (t) => {
  const ctx = project(t);
  const agent = { cwd: ctx.root, env: ctx.agentEnv, deps: ctx.deps };
  const person = { cwd: ctx.root, env: ctx.env, deps: ctx.deps };
  await captureRun(['connect', '--as', 'codex', '--json'], agent);
  await captureRun(['connect', '--as', 'devin', '--json'], agent);
  const task = JSON.parse((await captureRun(['task', 'Check the page title', '--to', 'codex', '--json'], person)).stdout);
  await captureRun(['claim', task.card_id, '--as', 'codex', '--json'], agent);
  assert.equal((await captureRun(['ask', task.card_id, '--as', 'devin', 'Which title?', '--json'], agent)).code, 1);
  const asked = await captureRun(['ask', task.card_id, '--as', 'codex', 'Which title should I use?', '--json'], agent);
  assert.equal(asked.code, 0, asked.stdout);
  assert.match((await captureRun(['ask', task.card_id, '--as', 'codex', 'Another question?', '--json'], agent)).stdout, /Which title should I use/);
  const ownerView = JSON.parse((await captureRun(['--json'], person)).stdout);
  assert.equal(ownerView.focus.needs_decision, true);
  assert.equal(ownerView.focus.why, 'Which title should I use?');
  assert.equal((await captureRun(['yes', task.card_id, '--json'], person)).code, 1);
  const leases = path.join(ctx.root, '.atris', 'state', 'feed', 'leases.json');
  const data = JSON.parse(fs.readFileSync(leases, 'utf8'));
  data[task.card_id].expires_at_ms = Date.now() - 1000;
  fs.writeFileSync(leases, JSON.stringify(data));
  assert.match((await captureRun(['claim', task.card_id, '--as', 'devin', '--json'], agent)).stdout, /waiting for the owner's answer/);
  room.reply(ctx.root, task.card_id, 'I am checking too', { as: 'devin', env: ctx.agentEnv });
  assert.equal(JSON.parse((await captureRun(['ask', task.card_id, '--as', 'codex', '--answer', '--json'], agent)).stdout).ask.answer, null);
  assert.equal((await captureRun(['talk', task.card_id, 'Use the shorter title', '--json'], person)).code, 0);
  const polled = JSON.parse((await captureRun(['ask', task.card_id, '--as', 'codex', '--answer', '--json'], agent)).stdout);
  assert.equal(polled.ask.answer, 'Use the shorter title');
  assert.ok(polled.ask.answered_at);
  const again = JSON.parse((await captureRun(['claim', task.card_id, '--as', 'codex', '--json'], agent)).stdout);
  assert.equal(again.handoff.ask.answer, 'Use the shorter title');
  const receipt = JSON.parse((await captureRun(['receipt', task.card_id, '--json'], agent)).stdout);
  assert.equal(receipt.asks.length, 1);
  assert.equal(receipt.asks[0].answer, 'Use the shorter title');
  // The answer hands the card back: the helper reports and finishes as before, and nothing still waits on the person.
  assert.equal((await captureRun(['progress', task.card_id, '--as', 'codex', 'Using the shorter title'], agent)).code, 0);
  const done = await captureRun(['complete', task.card_id, '--as', 'codex', '--proof', 'Read the page and the title is short', '--json'], agent);
  assert.equal(done.code, 0, done.stdout);
  const after = JSON.parse((await captureRun(['receipt', task.card_id, '--json'], agent)).stdout);
  assert.equal(after.state, 'waiting for the owner to accept');
  assert.equal(after.asks.length, 1);
});

test('element redirects work with history while preserving owner permissions', async (t) => {
  const ctx = project(t);
  const agent = { cwd: ctx.root, env: ctx.agentEnv, deps: ctx.deps };
  const person = { cwd: ctx.root, env: ctx.env, deps: ctx.deps };
  await captureRun(['connect', '--as', 'codex', '--json'], agent);
  await captureRun(['connect', '--as', 'devin', '--json'], agent);
  const task = JSON.parse((await captureRun(['task', 'Check the footer links', '--to', 'codex', '--json'], person)).stdout);
  await captureRun(['claim', task.card_id, '--as', 'codex', '--json'], agent);
  await captureRun(['progress', task.card_id, '--as', 'codex', 'Found two old links'], agent);
  assert.equal((await captureRun(['redirect', task.card_id, '--as', 'devin', '--to', 'writer', '--json'], agent)).code, 1);
  assert.equal((await captureRun(['redirect', task.card_id, '--as', 'codex', '--to', 'codex', '--json'], agent)).code, 1);
  const passed = await captureRun(['redirect', task.card_id, '--as', 'codex', '--to', 'devin', '--note', 'They know this page', '--json'], agent);
  assert.equal(passed.code, 0, passed.stdout);
  const got = JSON.parse((await captureRun(['claim', task.card_id, '--as', 'devin', '--json'], agent)).stdout);
  assert.deepEqual(got.handoff.passed_on, { from: 'codex', note: 'They know this page', progress: ['Found two old links'] });
  const receipt = JSON.parse((await captureRun(['receipt', task.card_id, '--json'], agent)).stdout);
  assert.equal(receipt.redirects[0].to, 'devin');
  const localTask = JSON.parse((await captureRun(['task', 'Check the help page', '--to', 'codex', '--json'], person)).stdout);
  const local = JSON.parse((await captureRun(['redirect', localTask.card_id, '--to', 'writer', '--json'], person)).stdout);
  assert.equal(local.started, true, JSON.stringify(local));
  const idea = feed.proposeCard(ctx.root, { as: 'codex', title: 'Check the pricing page', why: 'Keep prices clear', env: ctx.agentEnv });
  assert.equal((await captureRun(['redirect', idea.card.id, '--to', 'devin', '--json'], person)).code, 0);
  assert.match((await captureRun(['claim', idea.card.id, '--as', 'devin', '--json'], agent)).stdout, /waits for the owner's yes/);
  const protectedTask = JSON.parse((await captureRun(['task', 'Refund the last order', '--to', 'codex', '--lane', 'money', '--json'], person)).stdout);
  assert.equal((await captureRun(['redirect', protectedTask.card_id, '--to', 'devin', '--json'], person)).code, 0);
  assert.match((await captureRun(['claim', protectedTask.card_id, '--as', 'devin', '--json'], agent)).stdout, /waits for the owner's yes/);
});

test('element completion offers only the next claimable card', async (t) => {
  const ctx = project(t);
  const agent = { cwd: ctx.root, env: ctx.agentEnv, deps: ctx.deps };
  const person = { cwd: ctx.root, env: ctx.env, deps: ctx.deps };
  await captureRun(['connect', '--as', 'codex', '--json'], agent);
  const first = JSON.parse((await captureRun(['task', 'Check the first page', '--to', 'codex', '--json'], person)).stdout);
  await captureRun(['task', 'Refund the first order', '--to', 'codex', '--lane', 'money', '--json'], person);
  const next = JSON.parse((await captureRun(['task', 'Check the second page', '--to', 'codex', '--json'], person)).stdout);
  await captureRun(['claim', first.card_id, '--as', 'codex', '--json'], agent);
  const done = JSON.parse((await captureRun(['complete', first.card_id, '--as', 'codex', '--proof', 'checked the page', '--json'], agent)).stdout);
  assert.equal(done.next_card.card, next.card_id);
  assert.match(done.next_card.claim, /element claim/);
  assert.equal(JSON.parse((await captureRun(['claim', '--as', 'codex', '--json'], agent)).stdout).card.id, next.card_id);
});

test('element connect includes personal lessons and live missions', async (t) => {
  const ctx = project(t);
  const agent = { cwd: ctx.root, env: ctx.agentEnv, deps: ctx.deps };
  await captureRun(['connect', '--as', 'codex', '--json'], agent);
  fs.writeFileSync(path.join(ctx.root, 'atris', 'team', 'codex', 'lessons.md'), '# Lessons\n- Check the footer\n');
  const joined = JSON.parse((await captureRun(['connect', '--as', 'codex', '--json'], agent)).stdout);
  assert.deepEqual(joined.context.your_lessons, ['Check the footer']);
  assert.ok(Array.isArray(joined.context.missions));
  assert.match(joined.commands.ask, /element ask/);
  assert.match(joined.commands.redirect, /element redirect/);
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
