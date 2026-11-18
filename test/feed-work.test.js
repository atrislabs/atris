'use strict';

// A teammate's comment on the person's post becomes real work: "Do this" (or
// a comment that is only "@member do it") proposes it as that member's idea
// and approves it through the one approved-work path, and its state and
// result come back to the same post. Every run and every model turn here is a
// stand-in; nothing real starts and nothing spends.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const feed = require('../lib/feed-core');
const room = require('../lib/feed-room');
const team = require('../lib/feed-team');
const host = require('../lib/feed-host');
const work = require('../lib/feed-work');
const tasks = require('../lib/task-db');
const { project } = require('./helpers/feed-project');

const BIN = path.join(__dirname, '..', 'bin', 'atris.js');

function post(ctx, text = 'I want more people to come back to the candle shop') {
  return room.say(ctx.root, { text, env: ctx.env, deps: ctx.deps }).card;
}

function memberSays(ctx, cardId, as, text) {
  return room.reply(ctx.root, cardId, text, { as, fromAsk: true, env: ctx.env, deps: ctx.deps }).reply;
}

function postCard(ctx, id) {
  return feed.listCards(ctx.root, { limit: 100, env: ctx.env }).cards.find((c) => c.id === id);
}

function ideaRows(ctx) {
  return ctx.db.prepare('SELECT id, title, status, metadata FROM tasks').all().map((r) => ({ ...r, metadata: JSON.parse(r.metadata || '{}') }));
}

test('do this: the comment becomes that member\'s approved work, started once, and its state lives on the post', (t) => {
  const ctx = project(t, ['writer', 'closer']);
  const card = post(ctx);
  const said = memberSays(ctx, card.id, 'writer', 'Write a thank you note for the ten newest buyers. Keep it short.');
  memberSays(ctx, card.id, 'closer', 'A small loyalty card could help too.');
  const out = work.startWork(ctx.root, card.id, { replyId: said.id, env: ctx.env, deps: ctx.deps });
  assert.equal(out.replayed, false);
  assert.equal(out.started, true);
  assert.equal(out.work.member, 'writer');
  assert.equal(out.work.status, 'working');
  assert.equal(ctx.spawned.length, 1, 'one run started, through the run queue');
  assert.equal(ctx.spawned[0].member, 'writer');
  // The task is the member's own idea, approved by the person, and remembers where it came from.
  const rows = ideaRows(ctx);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, 'Write a thank you note for the ten newest buyers.');
  assert.equal(rows[0].metadata.assigned_to, 'writer');
  assert.equal(rows[0].metadata.feed.author, 'agent:writer');
  assert.equal(rows[0].metadata.feed.created_by, 'user:owner');
  assert.deepEqual(rows[0].metadata.feed.origin, { card_id: card.id, reply_id: said.id, via: 'button' });
  assert.match(rows[0].metadata.objective, /The owner's post: I want more people to come back to the candle shop/);
  assert.ok(Object.values(rows[0].metadata.feed.decisions).some((d) => d.choice === 'approve' && d.by === 'user:owner'));
  // The post shows the work, on a fresh read of the whole feed.
  const shown = postCard(ctx, card.id);
  assert.deepEqual(shown.work.map((w) => [w.member, w.reply_id, w.status]), [['writer', said.id, 'working']]);
  // A second tap, a third: the same work, nothing new.
  const again = work.startWork(ctx.root, card.id, { replyId: said.id, env: ctx.env, deps: ctx.deps });
  const third = work.startWork(ctx.root, card.id, { replyId: said.id, retry: true, env: ctx.env, deps: ctx.deps });
  assert.equal(again.replayed, true);
  assert.equal(third.replayed, true, 'retry does nothing while the work is still going');
  assert.equal(ideaRows(ctx).length, 1, 'no second task');
  assert.equal(ctx.spawned.length, 1, 'no second run');
  assert.equal(ctx.turns.length, 0, 'no model turn');
});

test('do this: the result comes back to the post, first as finished for your ok, then done with its proof', (t) => {
  const ctx = project(t, ['writer']);
  const card = post(ctx);
  const said = memberSays(ctx, card.id, 'writer', 'Write a thank you note for the ten newest buyers.');
  const out = work.startWork(ctx.root, card.id, { replyId: said.id, env: ctx.env, deps: ctx.deps });
  const ideaId = out.work.card_id;
  const before = feed.listCards(ctx.root, { env: ctx.env }).next_since;
  team.emit(ctx.root, { as: 'writer', type: 'result', card: ideaId, proof: 'Wrote the note and read it aloud twice.', env: ctx.env });
  let shown = postCard(ctx, card.id).work[0];
  assert.equal(shown.status, 'review');
  assert.match(shown.result_card_id, /:accept$/);
  // The post moves in a live (delta) read when its work moves, so a watching screen shows the new state.
  const delta = feed.listCards(ctx.root, { since: String(Number(before) - 1), env: ctx.env }).cards.map((c) => c.id);
  assert.ok(delta.includes(card.id), 'the post rides along in the delta read');
  const taskId = ideaId.split(':')[1];
  ctx.db.prepare("UPDATE tasks SET status = 'done', done_at = ?, updated_at = ? WHERE id = ?").run(Date.now(), Date.now(), taskId);
  tasks.updateTaskMetadata(ctx.db, taskId, (m) => { m.result = 'The note is written.'; m.feed.decisions[`task:${taskId}:1:accept`] = { choice: 'approve', by: 'user:owner', at: new Date().toISOString() }; return m; });
  shown = postCard(ctx, card.id).work[0];
  assert.equal(shown.status, 'done');
  assert.match(shown.result_card_id, /:result$/);
  assert.equal(shown.message, 'The note is written.');
  assert.ok(['verified', 'unverified', 'none'].includes(shown.proof));
});

test('do this: an asleep member says so on the post and starts nothing; after waking, a retry starts the same one task', (t) => {
  const ctx = project(t, ['writer']);
  const card = post(ctx);
  const said = memberSays(ctx, card.id, 'writer', 'Write a thank you note for the ten newest buyers.');
  team.setOn(ctx.root, 'writer', false, { env: ctx.env });
  const out = work.startWork(ctx.root, card.id, { replyId: said.id, env: ctx.env, deps: ctx.deps });
  assert.equal(out.started, false);
  assert.equal(out.work.status, 'failed');
  assert.match(out.work.message, /writer is off, so nothing was started/);
  assert.equal(out.work.can_retry, true);
  assert.equal(ctx.spawned.length, 0);
  team.setOn(ctx.root, 'writer', true, { env: ctx.env });
  const retried = work.startWork(ctx.root, card.id, { replyId: said.id, env: ctx.env, deps: ctx.deps });
  assert.equal(retried.work.status, 'working');
  assert.equal(ctx.spawned.length, 1);
  assert.equal(ideaRows(ctx).length, 1, 'the same task, not a second one');
});

test('do this: work that did not finish (a restart killed it) says so on the post; only the person\'s retry starts it again', (t) => {
  const ctx = project(t, ['writer']);
  const card = post(ctx);
  const said = memberSays(ctx, card.id, 'writer', 'Write a thank you note for the ten newest buyers.');
  work.startWork(ctx.root, card.id, { replyId: said.id, env: ctx.env, deps: ctx.deps });
  // The computer restarted: the runner is gone and the queue puts the card back.
  team.repair(ctx.root, { env: ctx.env, deps: { isAlive: () => false, spawnRunner: () => 424242, memberStillWorking: () => false } });
  const shown = postCard(ctx, card.id).work[0];
  assert.equal(shown.status, 'failed');
  assert.match(shown.message, /It did not finish/);
  assert.equal(shown.can_retry, true);
  const plainTap = work.startWork(ctx.root, card.id, { replyId: said.id, env: ctx.env, deps: ctx.deps });
  assert.equal(plainTap.replayed, true, 'a tap without retry never restarts work by itself');
  const retried = work.startWork(ctx.root, card.id, { replyId: said.id, retry: true, env: ctx.env, deps: ctx.deps });
  assert.equal(retried.replayed, false);
  assert.equal(retried.work.status, 'working');
  assert.equal(ideaRows(ctx).length, 1);
  assert.equal(ctx.spawned.length, 2, 'one run before, one after the person asked again');
});

test('do this: work in a protected lane is handed over but waits for the person, and the post says why', (t) => {
  const ctx = project(t, ['closer']);
  const card = post(ctx, 'Lots of buyers left this month');
  const said = memberSays(ctx, card.id, 'closer', 'Offer a refund to the three buyers who wrote in.');
  const out = work.startWork(ctx.root, card.id, { replyId: said.id, env: ctx.env, deps: ctx.deps });
  assert.equal(out.started, false);
  assert.equal(out.work.status, 'needs_you');
  assert.match(out.work.message, /This touches money, so it waits for you/);
  assert.equal(ctx.spawned.length, 0, 'no member runs protected work');
});

test('do this: only a person, only a teammate\'s comment on this card, and never a card from another project', (t) => {
  const ctx = project(t, ['writer']);
  const other = project(t, ['writer']);
  const card = post(ctx);
  const said = memberSays(ctx, card.id, 'writer', 'Write a thank you note for the ten newest buyers.');
  const mine = room.reply(ctx.root, card.id, 'Sounds good to me.', { env: ctx.env }).reply;
  assert.throws(() => work.startWork(ctx.root, card.id, { replyId: said.id, env: ctx.agentEnv, deps: ctx.deps }), /Only a person can turn a comment into work/);
  assert.throws(() => work.startWork(ctx.root, card.id, { replyId: mine.id, env: ctx.env, deps: ctx.deps }), /Only a teammate's comment can become work/);
  assert.throws(() => work.startWork(ctx.root, card.id, { replyId: 'abcdefabcdef', env: ctx.env, deps: ctx.deps }), /That comment is not on this card/);
  assert.throws(() => work.startWork(other.root, card.id, { replyId: said.id, env: other.env, deps: other.deps }), /Card not found/);
  // A link written by hand to another project's task is never read through.
  const theirs = feed.proposeCard(other.root, { as: 'writer', title: 'Their own idea', why: 'Theirs', env: other.env });
  const out = work.startWork(ctx.root, card.id, { replyId: said.id, env: ctx.env, deps: ctx.deps });
  const file = work.workFile(ctx.root);
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data[card.id][0].task_id = theirs.card.source.id;
  fs.writeFileSync(file, JSON.stringify(data));
  const shown = postCard(ctx, card.id).work.find((w) => w.id === out.work.id);
  assert.equal(shown.status, 'failed');
  assert.match(shown.message, /gone/);
});

test('"@writer do it" on the post starts the work like Do this; it does not start a discussion round', async (t) => {
  const ctx = project(t, ['writer', 'closer']);
  ctx.env.ATRIS_FEED_MEMBER_GAP_SECONDS = '0';
  ctx.deps.answer = (prompt) => (/You are Atris, the host/.test(prompt) ? 'PICK closer: the price' : 'I would start with the newest buyers.');
  const card = post(ctx);
  await host.discuss(ctx.root, card.id, { env: ctx.env, deps: ctx.deps, inline: true });
  assert.equal(ctx.turns.length, 2, 'one pick and one answer');
  const said = memberSays(ctx, card.id, 'writer', 'Write a thank you note for the ten newest buyers.');
  const out = room.reply(ctx.root, card.id, '@writer do it', { env: ctx.env, deps: ctx.deps });
  assert.equal(out.reply.command, 'work');
  assert.equal(out.work.reply_id, said.id);
  assert.equal(out.work.via, 'mention');
  assert.equal(out.work.status, 'working');
  assert.equal(ctx.spawned.length, 1);
  // The desktop asks Atris about the person's newest words after a reply: an instruction starts no round.
  const next = await host.discuss(ctx.root, card.id, { env: ctx.env, deps: ctx.deps, inline: true });
  assert.equal(next.started, false);
  assert.equal(ctx.turns.length, 2, 'no model turn for "do it"');
  // And it is not a comment for members to answer on their next look.
  await team.pingStream(ctx.root, { reason: 'refresh', env: ctx.env, deps: ctx.deps, onEvent: () => {} });
  const looks = ctx.turns.slice(2).map((turn) => turn.prompt);
  assert.equal(looks.length, 2, 'each awake member looked once');
  for (const prompt of looks) assert.doesNotMatch(prompt, /the owner said: "@writer do it"/);
});

test('ordinary mentions and talk never start work', (t) => {
  const ctx = project(t, ['writer']);
  const card = post(ctx);
  memberSays(ctx, card.id, 'writer', 'Write a thank you note for the ten newest buyers.');
  for (const words of [
    '@writer what do you think?',
    '@writer do it, and also tell me what it costs',
    'I think we should do it',
    'do it',
    '@nobody do it',
    'Tell @writer to do it later',
  ]) {
    const out = room.reply(ctx.root, card.id, words, { env: ctx.env, deps: ctx.deps });
    assert.equal(out.work, undefined, words);
    assert.equal(out.reply.command, undefined, words);
  }
  // A member writing the words starts nothing either.
  const fromMember = room.reply(ctx.root, card.id, '@writer do it', { as: 'writer', fromAsk: true, env: ctx.env, deps: ctx.deps });
  assert.equal(fromMember.work, undefined);
  // "@closer do it" when closer said nothing on this card is just a mention.
  const other = project(t, ['writer', 'closer']);
  const card2 = post(other);
  memberSays(other, card2.id, 'writer', 'Write a thank you note.');
  assert.equal(room.reply(other.root, card2.id, '@closer do it', { env: other.env, deps: other.deps }).work, undefined);
  assert.equal(ideaRows(ctx).length + ideaRows(other).length, 0, 'no task anywhere');
  assert.equal(ctx.spawned.length + other.spawned.length, 0);
});

test('"@writer do it" asked by name (the discussion box) saves the instruction, starts the work, and asks no model', async (t) => {
  const ctx = project(t, ['writer']);
  const card = post(ctx);
  const said = memberSays(ctx, card.id, 'writer', 'Write a thank you note for the ten newest buyers.');
  const events = [];
  const out = await team.askMember(ctx.root, { member: 'writer', cardId: card.id, text: '@writer do it', env: ctx.env, deps: ctx.deps, onEvent: (e) => events.push(e) });
  assert.equal(out.reply, null);
  assert.equal(out.work.reply_id, said.id);
  assert.equal(out.work.status, 'working');
  assert.deepEqual(events.map((e) => e.type), ['saved', 'done']);
  assert.equal(ctx.turns.length, 0, 'no model turn');
  assert.equal(ctx.spawned.length, 1);
});

function runCli(cwd, args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.on('close', (code) => resolve({ code, stdout }));
  });
}

test('cli: two windows tapping Do this at the same moment make one task and one run', async (t) => {
  const ctx = project(t, ['writer']);
  const card = post(ctx);
  const said = memberSays(ctx, card.id, 'writer', 'Write a thank you note for the ten newest buyers.');
  const starts = path.join(ctx.dir, 'runner-starts.txt');
  const env = { ...ctx.env, ATRIS_FEED_FAKE_RUNNER: starts };
  const [a, b] = await Promise.all([
    runCli(ctx.root, ['feed', 'work', '--reply', said.id, '--json', '--', card.id], env),
    runCli(ctx.root, ['feed', 'work', '--reply', said.id, '--json', '--', card.id], env),
  ]);
  assert.equal(a.code, 0, a.stdout);
  assert.equal(b.code, 0, b.stdout);
  const outs = [JSON.parse(a.stdout), JSON.parse(b.stdout)];
  assert.equal(outs.filter((o) => o.replayed).length, 1, 'one of them found the other\'s');
  assert.equal(ideaRows(ctx).length, 1);
  assert.equal(fs.readFileSync(starts, 'utf8').trim().split('\n').length, 1, 'one run');
  // The link survives a restart: a fresh process reads the same state from disk.
  const later = await runCli(ctx.root, ['feed', 'cards', '--json'], env);
  const shown = JSON.parse(later.stdout).cards.find((c) => c.id === card.id);
  assert.equal(shown.work.length, 1);
  assert.equal(shown.work[0].member, 'writer');
});

test('independent view: the member reads the owner\'s words, not teammates\' answers', async (t) => {
  const ctx = project(t, ['writer', 'closer']);
  ctx.env.ATRIS_FEED_MEMBER_GAP_SECONDS = '0';
  let n = 0;
  ctx.deps.answer = () => `A price idea, take ${(n += 1)}.`;
  const card = post(ctx);
  memberSays(ctx, card.id, 'writer', 'Write a thank you note for the ten newest buyers.');
  room.reply(ctx.root, card.id, 'What else could bring them back?', { env: ctx.env });
  await team.askMember(ctx.root, { member: 'closer', cardId: card.id, independent: true, env: ctx.env, deps: ctx.deps });
  const prompt = ctx.turns[ctx.turns.length - 1].prompt;
  assert.match(prompt, /independent view/);
  assert.match(prompt, /The owner: What else could bring them back\?/);
  assert.doesNotMatch(prompt, /thank you note/, 'no teammate answer shown');
  await team.askMember(ctx.root, { member: 'closer', cardId: card.id, env: ctx.env, deps: ctx.deps });
  assert.match(ctx.turns[ctx.turns.length - 1].prompt, /writer: Write a thank you note/, 'a normal ask still reads the thread');
});

test('explicit work keeps the tagged owner and post context even when suggestions match', (t) => {
  const ctx = project(t, ['writer', 'closer']);
  const first = post(ctx, 'Help the candle shop');
  const second = post(ctx, 'Help the flower shop');
  const a = memberSays(ctx, first.id, 'writer', 'Write a thank you note for the newest buyers.');
  const b = memberSays(ctx, second.id, 'closer', 'Write a thank you note for the newest buyers.');
  const one = work.startWork(ctx.root, first.id, { replyId: a.id, env: ctx.env, deps: ctx.deps });
  const two = work.startWork(ctx.root, second.id, { replyId: b.id, env: ctx.env, deps: ctx.deps });
  assert.notEqual(two.work.card_id, one.work.card_id);
  assert.equal(two.work.member, 'closer');
  assert.equal(ideaRows(ctx).length, 2);
});

test('a lost link recovers the exact completed task without creating or running another', (t) => {
  const ctx = project(t, ['writer']);
  const card = post(ctx);
  const said = memberSays(ctx, card.id, 'writer', 'Write a thank you note for the newest buyers.');
  const first = work.startWork(ctx.root, card.id, { replyId: said.id, env: ctx.env, deps: ctx.deps });
  const id = first.work.card_id.split(':')[1];
  ctx.db.prepare("UPDATE tasks SET status = 'done', done_at = ?, updated_at = ? WHERE id = ?").run(Date.now(), Date.now(), id);
  fs.writeFileSync(work.workFile(ctx.root), '{}');
  const recovered = work.startWork(ctx.root, card.id, { replyId: said.id, env: ctx.env, deps: ctx.deps });
  assert.equal(recovered.work.card_id, first.work.card_id);
  assert.equal(recovered.work.status, 'done');
  assert.equal(ideaRows(ctx).length, 1);
  assert.equal(ctx.spawned.length, 1);
});

test('an interrupted receipt save cannot hide a running or completed linked task', (t) => {
  const ctx = project(t, ['writer']);
  const card = post(ctx);
  const said = memberSays(ctx, card.id, 'writer', 'Write a thank you note for the newest buyers.');
  const first = work.startWork(ctx.root, card.id, { replyId: said.id, env: ctx.env, deps: ctx.deps });
  const file = work.workFile(ctx.root);
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data[card.id][0].state = 'starting';
  data[card.id][0].updated_at = new Date(0).toISOString();
  fs.writeFileSync(file, JSON.stringify(data));
  assert.equal(postCard(ctx, card.id).work[0].status, 'working');
  const id = first.work.card_id.split(':')[1];
  ctx.db.prepare("UPDATE tasks SET status = 'done', done_at = ?, updated_at = ? WHERE id = ?").run(Date.now(), Date.now(), id);
  data[card.id][0].state = 'failed';
  fs.writeFileSync(file, JSON.stringify(data));
  const shown = postCard(ctx, card.id).work[0];
  assert.equal(shown.status, 'done');
  assert.match(shown.result_card_id, /:result$/);
  assert.equal(shown.can_retry, false);
});

test('an interrupted protected-work receipt keeps the approval reason through retry', (t) => {
  const ctx = project(t, ['closer']);
  const card = post(ctx);
  const said = memberSays(ctx, card.id, 'closer', 'Offer a refund to the three buyers who wrote in.');
  work.startWork(ctx.root, card.id, { replyId: said.id, env: ctx.env, deps: ctx.deps });
  const file = work.workFile(ctx.root);
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data[card.id][0].state = 'starting';
  data[card.id][0].outcome = null;
  data[card.id][0].updated_at = new Date(0).toISOString();
  fs.writeFileSync(file, JSON.stringify(data));
  assert.equal(postCard(ctx, card.id).work[0].status, 'needs_you');
  const again = work.startWork(ctx.root, card.id, { replyId: said.id, retry: true, env: ctx.env, deps: ctx.deps });
  assert.equal(again.work.status, 'needs_you');
  assert.match(again.work.message, /money/);
  assert.equal(ctx.spawned.length, 0);
});
