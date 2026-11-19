'use strict';

// One discussion on every card: any awake member can be asked to answer on
// any card, every comment can be read, comments hold up to 1000 characters,
// and members answer people's comments inside the think turn they already
// take. Also `feed start` in a folder with atris/ and no team. Every engine
// here is a stand-in; nothing real starts and nothing spends.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const feed = require('../lib/feed-core');
const team = require('../lib/feed-team');
const room = require('../lib/feed-room');
const decisionFeed = require('../commands/decision-feed');
const { project } = require('./helpers/feed-project');

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
const BIN = path.join(__dirname, '..', 'bin', 'atris.js');

function idea(ctx, as, title, extra = {}) {
  return feed.proposeCard(ctx.root, { as, title, why: 'More people buy', env: ctx.env, ...extra }).card;
}

function ask(ctx, member, cardId, text, extra = {}) {
  const events = [];
  const run = team.askMember(ctx.root, { member, cardId, text, env: ctx.env, deps: ctx.deps, onEvent: (e) => events.push(e), ...extra });
  return run.then((out) => ({ out, events }));
}

function pings(ctx) {
  try { return JSON.parse(fs.readFileSync(path.join(ctx.root, '.atris', 'state', 'feed', 'pings.json'), 'utf8')); } catch { return null; }
}

function thinking(ctx, slug) {
  const file = path.join(ctx.root, '.atris', 'state', 'feed', `thinking-${slug}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
}

function answering(ctx, map) {
  ctx.deps.answer = (prompt) => {
    if (/The owner asked you to answer on a card/.test(prompt)) return map.ask || 'Yes, I can help with that.';
    if (/thinking up ideas for the owner's feed/.test(prompt)) return map.think || '';
    return 'Yes.';
  };
}

// ------------------------------------------------------------ A: ask any member

test('ask: any awake member answers on any card kind; the answer is saved as its comment and carried in the final event', async (t) => {
  const ctx = project(t, ['scout', 'writer', 'closer']);
  ctx.env.ATRIS_FEED_MEMBER_GAP_SECONDS = '0'; // four asks of one member in a row; the gap has its own test
  feed.setTheme(ctx.root, 'Get ten paying customers by December', { env: ctx.env });
  answering(ctx, { ask: 'I would start with the two buyers from last week.' });
  const proposal = idea(ctx, 'scout', 'Call the warm leads today');
  const question = idea(ctx, 'scout', 'Should we raise the candle price', { kind: 'question' });
  const ownerNote = room.say(ctx.root, { text: 'Who should we thank first this week?', env: ctx.env, deps: ctx.deps }).card;
  const memberPost = room.say(ctx.root, { as: 'closer', text: 'The spring order list is ready.', env: ctx.env, deps: ctx.deps }).card;
  for (const card of [proposal, question, ownerNote, memberPost]) {
    const before = ctx.turns.length;
    const { out, events } = await ask(ctx, 'writer', card.id, 'What do you think?');
    assert.equal(ctx.turns.length, before + 1, `one turn for ${card.kind}`);
    assert.deepEqual(out.reply.author, { id: 'agent:writer', name: 'writer', type: 'agent' });
    assert.equal(out.reply.text, 'I would start with the two buyers from last week.');
    assert.match(out.reply.id, /^[a-f0-9]{12}$/);
    assert.ok(out.reply.at);
    assert.equal(out.card.id, card.id);
    assert.equal(out.said.text, 'What do you think?');
    assert.deepEqual(out.said.author, { id: 'user:owner', name: 'You', type: 'user' });
    assert.deepEqual(out.card.replies.slice(-2).map((r) => r.author.id), ['user:owner', 'agent:writer']);
    assert.equal(events[0].type, 'saved');
    assert.equal(events[0].reply.text, 'What do you think?');
    assert.ok(events.filter((e) => e.type === 'chunk').length > 1, 'streamed in pieces');
    const done = events[events.length - 1];
    assert.equal(done.type, 'done');
    assert.deepEqual(Object.keys(done).sort(), ['card', 'member', 'reply', 'said', 'timing', 'type', 'version']);
    assert.deepEqual(done.reply, out.reply);
    // Visible to anyone who reads the card later.
    assert.equal(feed.readCard(ctx.root, card.id, { env: ctx.env }).replies.slice(-1)[0].text, out.reply.text);
  }
  const prompt = ctx.turns[ctx.turns.length - 1].prompt;
  assert.match(prompt, /You are writer/);
  assert.match(prompt, /Project goal: Get ten paying customers by December/);
  assert.match(prompt, /Card: The spring order list is ready\./);
  assert.match(prompt, /written by closer, state: done/);
  assert.match(prompt, /discussion on this card so far, oldest first[\s\S]*The owner: What do you think\?/);
  assert.equal(ctx.spawned.length, 0, 'no work run');
  assert.equal(ctx.thinkers.length, 0, 'no other member asked');
});

test('ask: the person\'s words are saved once; already saved by the app, or no words at all, nothing is saved twice', async (t) => {
  const ctx = project(t, ['scout', 'writer']);
  answering(ctx, {});
  const card = idea(ctx, 'scout', 'Call the warm leads today');
  room.reply(ctx.root, card.id, 'Can you start with the oldest?', { env: ctx.env });
  let { out } = await ask(ctx, 'writer', card.id, 'Can you start with the oldest?');
  assert.equal(out.card.reply_count, 2, 'the app already saved it: one person comment and the answer');
  assert.equal(room.replies(ctx.root, card.id, { env: ctx.env }).replies.filter((r) => r.author.type === 'user').length, 1);
  ({ out } = await ask(ctx, 'scout', card.id, ''));
  assert.equal(out.said, null, 'no words: the member answers the discussion as it is');
  assert.equal(out.card.reply_count, 3);
  assert.match(ctx.turns[ctx.turns.length - 1].prompt, /The owner: Can you start with the oldest\?\nwriter: Yes, I can help with that\./);
});

test('ask: refused in one plain sentence, with nothing saved and no turn, when the member, the card or a limit says no', async (t) => {
  const ctx = project(t, ['scout', 'writer', 'closer', 'extra']);
  answering(ctx, {});
  const card = idea(ctx, 'scout', 'Call the warm leads today');
  const refuse = async (options, status, pattern, env = ctx.env) => {
    const before = ctx.turns.length;
    await assert.rejects(team.askMember(ctx.root, { cardId: card.id, text: 'Hello?', env, deps: ctx.deps, ...options }),
      (e) => e instanceof feed.FeedError && e.status === status && pattern.test(e.message));
    assert.equal(ctx.turns.length, before, 'no turn');
    assert.equal(room.replies(ctx.root, card.id, { env: ctx.env }).reply_count, 0, 'nothing saved');
  };
  await refuse({ member: 'nobody' }, 404, /not on this project: nobody/);
  require('../lib/member-switches').setMemberAwake('closer', false, ctx.root);
  await refuse({ member: 'closer' }, 409, /closer is asleep, so it cannot answer/);
  await refuse({ member: 'writer', cardId: 'task:missing:1:proposal' }, 404, /Card not found/);
  await refuse({ member: 'writer', cardId: 'post:aaaaaaaaaaaa' }, 404, /Card not found/);
  await refuse({ member: 'writer' }, 403, /Only a person can ask a team member/, ctx.agentEnv);
  await refuse({ member: 'writer', text: 'y'.repeat(1001) }, 400, /under 1000/);
  await refuse({ member: 'writer' }, 429, /asked 0 times today/, { ...ctx.env, ATRIS_FEED_PINGS_PER_DAY: '0' });
  thinking(ctx, 'writer');
  await refuse({ member: 'writer' }, 409, /writer is already thinking/);
  thinking(ctx, 'scout');
  thinking(ctx, 'extra');
  await refuse({ member: 'closer' }, 409, /asleep/);
  require('../lib/member-switches').setMemberAwake('closer', true, ctx.root);
  await refuse({ member: 'closer' }, 409, /3 team members are already thinking, the most at once/);
});

test('ask: counts against the day\'s limit like a ping, waits out the gap between asks of one member, and starts nothing else', async (t) => {
  const ctx = project(t, ['scout', 'writer']);
  let n = 0;
  answering(ctx, {});
  const answer = ctx.deps.answer;
  ctx.deps.answer = (prompt) => `${answer(prompt)} Answer ${(n += 1)}.`;
  const card = idea(ctx, 'scout', 'Call the warm leads today');
  const env = { ...ctx.env, ATRIS_FEED_PINGS_PER_DAY: '2' };
  await team.askMember(ctx.root, { member: 'writer', cardId: card.id, text: 'First?', env, deps: ctx.deps });
  assert.equal(pings(ctx).local, 1);
  assert.equal(pings(ctx).members.writer.count, 1);
  const events = [];
  await team.askMember(ctx.root, { member: 'writer', cardId: card.id, text: 'Second?', env, deps: ctx.deps, onEvent: (e) => events.push(e) });
  assert.equal(pings(ctx).local, 2);
  assert.ok(ctx.deps.sleeps.length === 1 && ctx.deps.sleeps[0] > 0 && ctx.deps.sleeps[0] <= 5000, 'waited out the gap');
  assert.equal(events[0].type, 'waiting');
  await assert.rejects(team.askMember(ctx.root, { member: 'scout', cardId: card.id, text: 'Third?', env, deps: ctx.deps }), (e) => e.status === 429 && e.code === 'daily_limit');
  // The same count stops a ping.
  const ping = team.ping(ctx.root, { reason: 'scroll', env, deps: ctx.deps });
  assert.equal(ping.pinged, 0);
  assert.match(ping.reason, /the most allowed/);
  assert.equal(ctx.turns.length, 2);
  assert.equal(ctx.thinkers.length, 0, 'a saved answer never asks another member');
  assert.ok(!fs.existsSync(path.join(ctx.root, '.atris', 'state', 'feed', 'thinking-writer.json')), 'the thinking mark is gone after the ask');
});

test('ask: an answer that breaks off or is not plain words is not saved, and the turn still counts', async (t) => {
  const ctx = project(t, ['scout', 'writer']);
  const card = idea(ctx, 'scout', 'Call the warm leads today');
  ctx.deps.turn = async () => ({ ok: false, error: 'timed out' });
  await assert.rejects(team.askMember(ctx.root, { member: 'writer', cardId: card.id, env: ctx.env, deps: ctx.deps }), (e) => e.status === 502 && /took too long/.test(e.message));
  ctx.deps.turn = async ({ onText }) => { onText('It is in lib/sales.js somewhere.'); return { ok: true, text: 'It is in lib/sales.js somewhere.' }; };
  await assert.rejects(team.askMember(ctx.root, { member: 'writer', cardId: card.id, env: ctx.env, deps: { ...ctx.deps, isAlive: () => false } }), (e) => e.status === 422);
  assert.equal(room.replies(ctx.root, card.id, { env: ctx.env }).reply_count, 0);
  assert.equal(pings(ctx).local, 2);
});

test('cli: talk --member streams JSON events and ends with the saved comment; help names --member; an agent cannot use it', async (t) => {
  const ctx = project(t, ['scout', 'writer']);
  answering(ctx, { ask: 'Yes, the two newest buyers first.' });
  const card = idea(ctx, 'scout', 'Call the warm leads today');
  const lines = [];
  const code = await decisionFeed.run(['talk', '--stream', '--json', '--member', 'writer', '--', card.id, 'Who first?'], { cwd: ctx.root, env: ctx.env, deps: ctx.deps, write: (text) => lines.push(text) });
  assert.equal(code, 0);
  const events = lines.join('').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual([events[0].type, events[events.length - 1].type], ['saved', 'done']);
  const done = events[events.length - 1];
  assert.equal(done.reply.text, 'Yes, the two newest buyers first.');
  assert.equal(done.card.replies.slice(-1)[0].id, done.reply.id);
  if (process.env.FEED_DISCUSSION_PRINT) console.log(`FINAL STREAM EVENT ${JSON.stringify(done)}`);
  const help = spawnSync(process.execPath, [BIN, 'feed', 'talk', '--help'], { cwd: ctx.root, env: ctx.env, encoding: 'utf8' }).stdout;
  assert.match(help, /feed talk --member <name>[^\n]*--stream/);
  assert.match(help, /feed talk[^\n]*--stream\b/, 'the shipped app still finds streaming');
  assert.match(help, /feed replies <card>/);
  assert.match(help, /feed start <folder>[^\n]*--goal/);
  const agent = spawnSync(process.execPath, [BIN, 'feed', 'talk', '--stream', '--json', '--member', 'writer', '--', card.id, 'Hi'], { cwd: ctx.root, env: ctx.agentEnv, encoding: 'utf8' });
  assert.equal(agent.status, 1);
  const error = JSON.parse(agent.stdout.trim());
  assert.deepEqual([error.type, error.ok, error.error.status], ['error', false, 403]);
  const plain = spawnSync(process.execPath, [BIN, 'feed', 'talk', '--json', '--member', 'nobody', '--', card.id], { cwd: ctx.root, env: ctx.env, encoding: 'utf8' });
  assert.equal(plain.status, 1);
  assert.equal(JSON.parse(plain.stdout).error.status, 404);
  const both = spawnSync(process.execPath, [BIN, 'feed', 'talk', '--json', '--member', 'writer', '--as', 'scout', '--', card.id, 'Hi'], { cwd: ctx.root, env: ctx.env, encoding: 'utf8' });
  assert.equal(JSON.parse(both.stdout).error.status, 400);
});

// ------------------------------------------------------------ B: read every comment

test('replies: every saved comment on a card, oldest first, with a limit and a truncated flag', (t) => {
  const ctx = project(t, ['scout', 'writer']);
  const card = idea(ctx, 'scout', 'Call the warm leads today');
  const texts = ['First thought.', 'Second thought.', 'Third thought.', 'Fourth thought.', 'Fifth thought.'];
  for (const text of texts) room.reply(ctx.root, card.id, text, { env: ctx.env });
  room.reply(ctx.root, card.id, 'A member answer.', { as: 'writer', env: ctx.env });
  const all = room.replies(ctx.root, card.id, { env: ctx.env });
  assert.deepEqual(Object.keys(all).sort(), ['card', 'card_id', 'dropped', 'replies', 'reply_count', 'truncated', 'version']);
  assert.equal(all.card.id, card.id, 'the card comes with its comments, so its discussion and work state read in one call');
  assert.deepEqual(all.replies.map((r) => r.text), [...texts, 'A member answer.']);
  assert.equal(all.reply_count, 6);
  assert.equal(all.truncated, false);
  assert.deepEqual(Object.keys(all.replies[0]).sort(), ['at', 'author', 'id', 'text'], 'the same shape a card carries');
  assert.equal(feed.readCard(ctx.root, card.id, { env: ctx.env }).replies.length, 3, 'a card still carries the newest three');
  const two = room.replies(ctx.root, card.id, { env: ctx.env, limit: 2 });
  assert.deepEqual(two.replies.map((r) => r.text), ['Fifth thought.', 'A member answer.']);
  assert.equal(two.truncated, true);
  assert.throws(() => room.replies(ctx.root, card.id, { env: ctx.env, limit: '0' }), (e) => e.status === 400);
  assert.throws(() => room.replies(ctx.root, 'task:missing:1:proposal', { env: ctx.env }), (e) => e.status === 404);
  // Past the 50 a card keeps, the oldest go and the read says so.
  for (let i = 0; i < 50; i += 1) room.reply(ctx.root, card.id, `Reply number ${i}`, { env: ctx.env });
  const kept = room.replies(ctx.root, card.id, { env: ctx.env });
  assert.equal(kept.replies.length, 50);
  assert.equal(kept.replies[0].text, 'Reply number 0');
  assert.equal(kept.dropped, 6);
  assert.equal(kept.truncated, true);
  const cli = spawnSync(process.execPath, [BIN, 'feed', 'replies', card.id, '--limit', '2', '--json'], { cwd: ctx.root, env: ctx.env, encoding: 'utf8' });
  assert.equal(cli.status, 0);
  const json = JSON.parse(cli.stdout);
  assert.deepEqual(json.replies.map((r) => r.text), ['Reply number 48', 'Reply number 49']);
  if (process.env.FEED_DISCUSSION_PRINT) {
    const fresh = idea(ctx, 'writer', 'Thank the first ten buyers');
    room.reply(ctx.root, fresh.id, 'Which ten?', { env: ctx.env });
    room.reply(ctx.root, fresh.id, 'The ten who ordered first in March.', { as: 'writer', env: ctx.env });
    const out = spawnSync(process.execPath, [BIN, 'feed', 'replies', fresh.id, '--json'], { cwd: ctx.root, env: ctx.env, encoding: 'utf8' });
    console.log(`FEED REPLIES ${JSON.stringify(JSON.parse(out.stdout))}`);
  }
});

// ------------------------------------------------------------ C: longer comments

test('comments: 1000 characters are kept and 1001 refused, for a person and for a member; an ask answer is fitted to 1000', async (t) => {
  const ctx = project(t, ['scout', 'writer']);
  const card = idea(ctx, 'scout', 'Call the warm leads today');
  const long = 'Good idea. '.repeat(91).slice(0, 1000).trim().padEnd(1000, 'a');
  assert.equal(long.length, 1000);
  assert.equal(room.reply(ctx.root, card.id, long, { env: ctx.env }).reply.text.length, 1000);
  assert.equal(room.reply(ctx.root, card.id, `${long.slice(0, 999)}b`, { as: 'writer', env: ctx.env }).reply.text.length, 1000);
  assert.throws(() => room.reply(ctx.root, card.id, `${long}x`, { env: ctx.env }), (e) => e.status === 400 && /under 1000/.test(e.message));
  assert.throws(() => room.reply(ctx.root, card.id, `${long}x`, { as: 'writer', env: ctx.env }), (e) => e.status === 400 && /under 1000/.test(e.message));
  const card2 = feed.readCard(ctx.root, card.id, { env: ctx.env });
  assert.ok(card2.replies.every((r) => r.text.length === 1000), 'the card carries them whole');
  answering(ctx, { ask: 'That works well for us. '.repeat(60) });
  const { out } = await ask(ctx, 'writer', card.id, '');
  assert.ok(out.reply.text.length <= 1000 && out.reply.text.endsWith('.'), 'cut at a sentence, under the limit');
});

// ------------------------------------------------------------ D: members answer people, inside think

test('think: a member sees only people\'s new comments on open cards, answers within the caps, and adds no turn', async (t) => {
  const ctx = project(t, ['scout', 'writer', 'closer']);
  const cards = ['Thank the first ten buyers', 'Raise the candle price in spring', 'Send the soap samples to the shop downtown',
    'Fix the slow checkout page', 'Ask three owners for a quote'].map((title) => idea(ctx, 'scout', title));
  const gone = idea(ctx, 'scout', 'Write a long blog post');
  feed.decide(ctx.root, gone.id, 'dismiss', { env: ctx.env, deps: ctx.deps });
  for (const [i, card] of cards.entries()) room.reply(ctx.root, card.id, `Owner question ${i + 1}?`, { env: ctx.env });
  room.reply(ctx.root, gone.id, 'Owner words on a dismissed card.', { env: ctx.env });
  const teammate = idea(ctx, 'closer', 'Raise the soap price');
  room.reply(ctx.root, teammate.id, 'A teammate thought on soap.', { as: 'closer', env: ctx.env });
  await tick();
  const prompts = [];
  ctx.deps.turn = async ({ prompt, onText }) => {
    prompts.push(prompt);
    const text = ['ANSWER P1: First answer here.', 'ANSWER P1: A second answer on the same card.', 'ANSWER P2: Second answer here.',
      'ANSWER P3: Third answer here.', 'ANSWER P4: A fourth answer is one too many.', 'ANSWER P9: There is no such comment.', ''].join('\n');
    onText(text);
    return { ok: true, text };
  };
  const events = [];
  await team.pingStream(ctx.root, { member: 'writer', reason: 'scroll', env: ctx.env, deps: ctx.deps, onEvent: (e) => events.push(e) });
  assert.equal(prompts.length, 1, 'answers ride inside the one think turn');
  const prompt = prompts[0];
  assert.match(prompt, /Comments the owner left on open cards since you last thought/);
  for (let i = 1; i <= 5; i += 1) assert.match(prompt, new RegExp(`the owner said: "Owner question ${i}\\?"`));
  const block = prompt.slice(prompt.indexOf('Comments the owner left'));
  assert.doesNotMatch(block, /dismissed card/, 'a closed card is left out');
  assert.doesNotMatch(block, /teammate thought|soap price/, 'a member\'s comment is never offered to answer');
  assert.equal((block.match(/\[P\d+\]/g) || []).length, 5);
  const memberComments = cards.map((card) => room.replies(ctx.root, card.id, { env: ctx.env }).replies.filter((r) => r.author.id === 'agent:writer'));
  assert.equal(memberComments.flat().length, 3, 'at most three in one turn');
  assert.ok(memberComments.every((list) => list.length <= 1), 'at most one per card');
  assert.equal(events.find((e) => e.type === 'member_done').answers, 3);
  // The comments shown are read: the next thought sees only newer ones, and
  // a comment a member answered is not offered to anyone again.
  assert.ok(pings(ctx).members.writer.comments_seen_at);
  await tick();
  prompts.length = 0;
  await team.pingStream(ctx.root, { member: 'writer', reason: 'scroll', noRetry: true, env: ctx.env, deps: ctx.deps, onEvent: () => {} });
  assert.equal(prompts.length, 1);
  assert.doesNotMatch(prompts[0], /Comments the owner left/);
  prompts.length = 0;
  await team.pingStream(ctx.root, { member: 'scout', reason: 'scroll', env: ctx.env, deps: ctx.deps, onEvent: () => {} });
  const offered = (prompts[0].match(/\[P\d+\]/g) || []).length;
  assert.equal(offered, 2, 'scout is offered only the two comments nobody answered yet');
  assert.equal(ctx.thinkers.length, 0);
});

test('think: a member\'s comment never draws another member\'s comment', async (t) => {
  const ctx = project(t, ['scout', 'writer']);
  const card = idea(ctx, 'scout', 'Call the warm leads today');
  room.reply(ctx.root, card.id, 'I can call the first five tomorrow.', { as: 'scout', env: ctx.env });
  const prompts = [];
  ctx.deps.turn = async ({ prompt, onText }) => {
    prompts.push(prompt);
    const text = 'ANSWER P1: Great, I will help.\n';
    onText(text);
    return { ok: true, text };
  };
  await team.pingStream(ctx.root, { member: 'writer', reason: 'scroll', env: ctx.env, deps: ctx.deps, onEvent: () => {} });
  assert.doesNotMatch(prompts[0], /Comments the owner left/);
  assert.equal(room.replies(ctx.root, card.id, { env: ctx.env }).reply_count, 1, 'nothing was written');
  const dropped = team.readEvents(ctx.root).filter((e) => e.type === 'dropped');
  assert.ok(dropped.some((e) => /There is no comment P1/.test(e.text)));
});

test('refresh: a whole-team ask waits while members are still thinking, so no more than three ever think at once', (t) => {
  const ctx = project(t, ['scout', 'writer', 'closer', 'builder', 'editor']);
  thinking(ctx, 'scout');
  thinking(ctx, 'writer');
  thinking(ctx, 'closer');
  const out = team.ping(ctx.root, { reason: 'refresh', env: ctx.env, deps: ctx.deps });
  assert.equal(out.pinged, 0);
  assert.match(out.reason, /still thinking/);
  assert.equal(ctx.thinkers.length, 0);
});

// ------------------------------------------------------------ E: feed start

function snapshot(dir) {
  const out = {};
  const walk = (at) => {
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      const full = path.join(at, entry.name);
      if (entry.isDirectory()) { if (entry.name !== 'logs') walk(full); } // a member's own log records the ask
      else out[path.relative(dir, full)] = fs.readFileSync(full, 'utf8');
    }
  };
  walk(dir);
  return out;
}

function git(cwd, ...args) {
  return spawnSync('git', ['-c', 'user.name=Owner', '-c', 'user.email=owner@example.com', ...args], { cwd, encoding: 'utf8' });
}

test('start: atris/ with no team gets the starter team, and the person\'s own unsaved work is never committed or changed', async (t) => {
  const ctx = project(t, []);
  fs.writeFileSync(path.join(ctx.root, 'atris', '.config'), JSON.stringify({ keep: 'me', feed: { default_engine: 'codex' } }));
  fs.writeFileSync(path.join(ctx.root, 'index.js'), 'console.log("shop")\n');
  fs.writeFileSync(path.join(ctx.root, 'atris', 'notes.md'), '# my notes\n');
  git(ctx.root, 'init', '-q');
  git(ctx.root, 'add', '-A');
  git(ctx.root, 'commit', '-q', '-m', 'mine');
  fs.writeFileSync(path.join(ctx.root, 'index.js'), 'console.log("shop, changed")\n');
  fs.writeFileSync(path.join(ctx.root, 'draft.txt'), 'not saved yet\n');
  const before = snapshot(path.join(ctx.root, 'atris'));
  const status = git(ctx.root, 'status', '--porcelain').stdout;
  const env = { ...ctx.env, HOME: ctx.dir };
  const out = await team.start(ctx.root, { env, deps: ctx.deps });
  assert.equal(out.started, true);
  assert.deepEqual(out.created.sort(), ['builder', 'scout']);
  assert.ok(out.members.filter((m) => out.created.includes(m.name)).every((m) => m.on));
  assert.equal(team.readOnlyUntilApproved(ctx.root), true);
  assert.equal(git(ctx.root, 'log', '--oneline').stdout.trim().split('\n').length, 1, 'no commit was made');
  assert.equal(git(ctx.root, 'status', '--porcelain').stdout.split('\n').filter((l) => !/atris\//.test(l)).join('\n'),
    status.split('\n').filter((l) => !/atris\//.test(l)).join('\n'), 'the person\'s changes are still uncommitted, as they were');
  assert.equal(fs.readFileSync(path.join(ctx.root, 'index.js'), 'utf8'), 'console.log("shop, changed")\n');
  assert.equal(fs.readFileSync(path.join(ctx.root, 'draft.txt'), 'utf8'), 'not saved yet\n');
  const after = snapshot(path.join(ctx.root, 'atris'));
  for (const [file, text] of Object.entries(before)) {
    if (file === '.config') continue;
    assert.equal(after[file], text, `${file} unchanged`);
  }
  const config = JSON.parse(after['.config']);
  assert.equal(config.keep, 'me', 'the config keeps what it had');
  assert.equal(config.feed.default_engine, 'codex');
  assert.ok(Object.keys(after).filter((f) => !(f in before)).every((f) => /^team\/(scout|builder)\//.test(f) || f === '.config'), 'only the new members were added');
  assert.equal(out.ping.pinged, 2, 'one ask');
  assert.equal(ctx.thinkers.length, 1);
  if (process.env.FEED_DISCUSSION_PRINT) console.log(`START NO TEAM ${JSON.stringify(out)}`);
});

test('start: a folder whose team has a member is left byte for byte alone', async (t) => {
  const ctx = project(t, ['scout']);
  const before = snapshot(path.join(ctx.root, 'atris'));
  const out = await team.start(ctx.root, { env: ctx.env, deps: ctx.deps });
  assert.equal(out.started, false);
  assert.deepEqual(out.created, []);
  assert.deepEqual(snapshot(path.join(ctx.root, 'atris')), before);
  if (process.env.FEED_DISCUSSION_PRINT) console.log(`START HAS TEAM ${JSON.stringify(out)}`);
});

test('start --goal: the goal is saved before the first ask; one the goal check refuses stops start before anything is made', async (t) => {
  const ctx = project(t, []);
  const seen = [];
  const deps = { ...ctx.deps, spawnThinker: (root, names) => { seen.push({ names, goal: feed.readTheme(root, { agent: '' }).text }); } };
  const tooLong = 'Sell '.repeat(40).trim();
  await assert.rejects(team.start(ctx.root, { env: ctx.env, deps, goal: tooLong }), (e) => {
    let expected;
    try { feed.setTheme(ctx.root, tooLong, { env: ctx.env }); } catch (theme) { expected = theme; }
    return e.status === 400 && e.message === expected.message;
  });
  assert.ok(!fs.existsSync(path.join(ctx.root, 'atris', 'team')), 'no team was made');
  const out = await team.start(ctx.root, { env: ctx.env, deps, goal: 'Get ten paying customers by December' });
  assert.equal(out.goal, 'Get ten paying customers by December');
  assert.deepEqual(seen, [{ names: ['scout'], goal: 'Get ten paying customers by December' }]);
  const cli = spawnSync(process.execPath, [BIN, 'feed', 'start', ctx.root, '--goal', 'A new goal for the shop', '--json'], { cwd: ctx.root, env: { ...ctx.env, NODE_TEST_CONTEXT: 'child' }, encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).goal, 'A new goal for the shop');
  assert.equal(feed.readTheme(ctx.root, { agent: '' }).text, 'A new goal for the shop');
});

test('start: a fresh folder (shape for the report)', async (t) => {
  const ctx = project(t, []);
  const folder = path.join(ctx.dir, 'fresh');
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, 'README.md'), '# Notes\n');
  const out = await team.start(folder, { env: { ...ctx.env, HOME: ctx.dir }, deps: ctx.deps });
  assert.equal(out.started, true);
  assert.deepEqual(out.created.sort(), ['editor', 'scout']);
  if (process.env.FEED_DISCUSSION_PRINT) console.log(`START FRESH ${JSON.stringify(out)}`);
});
