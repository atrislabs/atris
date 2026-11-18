'use strict';

// The feed as a shared room: members post light notes and asks, anyone
// reacts and replies on any card, and members do it during an ask round.
// Notes are not tasks. Every model here is a stand-in.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const feed = require('../lib/feed-core');
const team = require('../lib/feed-team');
const room = require('../lib/feed-room');
const { project } = require('./helpers/feed-project');

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

function say(ctx, as, text, extra = {}) {
  return room.say(ctx.root, { as, text, env: ctx.env, deps: ctx.deps, ...extra });
}

function idea(ctx, as, title) {
  return feed.proposeCard(ctx.root, { as, title, why: 'More people buy', env: ctx.env }).card;
}

function list(ctx, options = {}) {
  return feed.listCards(ctx.root, { env: ctx.env, limit: 100, ...options });
}

function streaming(text, prompts = []) {
  return async ({ prompt, onText }) => {
    prompts.push(prompt);
    for (const piece of text.match(/.{1,5}/gs) || []) onText(piece);
    return { ok: true, text };
  };
}

async function askRound(ctx, member) {
  const events = [];
  await team.pingStream(ctx.root, { member, reason: 'scroll', env: ctx.env, deps: ctx.deps, onEvent: (e) => events.push(e) });
  return events;
}

function socialFile(ctx) {
  return JSON.parse(fs.readFileSync(room.socialFile(ctx.root), 'utf8'));
}

test('say: a post and an ask become cards in time order, never waiting for a decision', async (t) => {
  const ctx = project(t, ['scout', 'writer']);
  const first = idea(ctx, 'scout', 'Call the warm leads today');
  await tick();
  const post = say(ctx, 'writer', 'The soap page loads fast now, and it feels good.').card;
  await tick();
  const second = idea(ctx, 'writer', 'Write the spring price note');
  await tick();
  const ask = say(ctx, 'scout', 'Does anyone know which candle sold best last week?', { ask: true }).card;
  assert.equal(post.kind, 'post');
  assert.equal(ask.kind, 'ask');
  assert.match(post.id, /^post:[a-f0-9]{12}$/);
  for (const card of [post, ask]) {
    assert.equal(card.body, '');
    assert.equal(card.why, null);
    assert.equal(card.state, 'done');
    assert.equal(card.needs_decision, false);
    assert.equal(card.can_decide, false);
    assert.deepEqual(card.reactions, []);
    assert.deepEqual(card.replies, []);
    assert.equal(card.reply_count, 0);
  }
  assert.deepEqual(post.author, { id: 'agent:writer', name: 'writer', type: 'agent' });
  assert.equal(post.title, 'The soap page loads fast now, and it feels good.');
  const out = list(ctx);
  assert.deepEqual(out.cards.map((c) => c.id), [first.id, post.id, second.id, ask.id], 'oldest first, each note after every older card');
  assert.equal(out.counts.needs_decision, 2, 'notes are not waiting for a decision');
  assert.equal(out.counts.new_results, 0);
  assert.deepEqual(list(ctx, { filter: 'needs_decision' }).cards.map((c) => c.id), [first.id, second.id]);
  assert.ok(!list(ctx, { filter: 'done' }).cards.some((c) => c.id.startsWith('post:')));
  // A note is a line in the feed's own file, not a task.
  assert.equal(room.readNotes(ctx.root).length, 2);
  assert.equal(require('../lib/task-db').listTasks(ctx.db, { workspaceRoot: ctx.root }).length, 2);
  const events = team.readEvents(ctx.root).map((e) => e.type);
  assert.ok(events.includes('post') && events.includes('ask'));
});

test('say: plain short notes from a member that is on; copies and long or technical notes are refused', (t) => {
  const ctx = project(t, ['scout', 'writer', 'quiet'], { on: false });
  require('../lib/member-switches').setMemberAwake('scout', true, ctx.root);
  require('../lib/member-switches').setMemberAwake('writer', true, ctx.root);
  say(ctx, 'scout', 'We fixed the slow soap page and buyers stayed longer.');
  const refused = (fn, status, pattern) => assert.throws(fn, (e) => e instanceof feed.FeedError && e.status === status && pattern.test(e.message));
  refused(() => say(ctx, 'writer', 'We fixed the slow soap page, and buyers stayed longer!'), 409, /already said/);
  refused(() => say(ctx, 'writer', 'we fixed the slow soap page and buyers stayed longer.'), 409, /already said/);
  refused(() => say(ctx, 'writer', 'x'.repeat(281)), 400, /under 280/);
  refused(() => say(ctx, 'writer', 'One thing. Two things. Three things.'), 400, /one or two sentences/);
  refused(() => say(ctx, 'writer', 'I pushed the fix in lib/feed-core.js today.'), 400, /plain words/);
  refused(() => say(ctx, 'writer', '   '), 400, /one or two sentences/);
  refused(() => say(ctx, 'quiet', 'Hello from the quiet one.'), 409, /is off/);
  refused(() => say(ctx, 'nobody', 'Hello there.'), 404, /not on this project/);
  // Without --as the note is the person's own, in their own words; inside an agent it is refused.
  const mine = room.say(ctx.root, { text: 'clove sold out by noon lol, what should the box look like?', ask: true, env: ctx.env });
  assert.equal(mine.card.kind, 'ask');
  assert.equal(mine.card.author.type, 'user');
  refused(() => room.say(ctx.root, { text: 'Hello there.', env: { ...ctx.env, CLAUDECODE: '1' } }), 403, /Only a person/);
  const brief = team.roomBrief(ctx.root, 'scout', { env: ctx.env });
  assert.equal(brief.owner_open.length, 1);
  assert.match(team.ideaPrompt(ctx.root, 'scout', 'scroll', null, false, brief), /The owner wrote \[\d+\] to the team and nobody has answered yet/);
  // The member's own day cap applies, except in an ask round.
  const capped = { ...ctx.env, ATRIS_FEED_EMITS_PER_MEMBER_PER_DAY: '1' };
  refused(() => say(ctx, 'scout', 'The candle labels look much clearer now.', { env: capped }), 429, /already put 1 things/);
  assert.equal(say(ctx, 'scout', 'The candle labels look much clearer now.', { env: capped, fromAsk: true }).card.kind, 'post');
});

test('react: toggles for the caller, shows who and mine, only the five, and moves the card in a delta', async (t) => {
  const ctx = project(t, ['scout', 'writer']);
  const card = idea(ctx, 'scout', 'Call the warm leads today');
  const since = list(ctx).next_since;
  await tick();
  let out = room.react(ctx.root, card.id, '👍', { env: ctx.env });
  assert.deepEqual(out.card.reactions, [{ emoji: '👍', count: 1, by: [{ id: 'user:owner', name: 'You' }], mine: true }]);
  assert.deepEqual(list(ctx, { since }).cards.map((c) => c.id), [card.id], 'a reaction moves its card in a delta list');
  out = room.react(ctx.root, card.id, 'fire', { as: 'writer', env: ctx.env });
  out = room.react(ctx.root, card.id, '👍', { as: 'writer', env: ctx.env });
  assert.deepEqual(out.card.reactions.map((r) => [r.emoji, r.count, r.mine]), [['👍', 2, true], ['🔥', 1, false]], 'in the fixed order');
  out = room.react(ctx.root, card.id, '👍', { env: ctx.env });
  assert.deepEqual(out.card.reactions[0], { emoji: '👍', count: 1, by: [{ id: 'agent:writer', name: 'writer' }], mine: false }, 'a second tap takes it off');
  assert.equal(room.react(ctx.root, card.id, '❤', { env: ctx.env }).card.reactions.find((r) => r.emoji === '❤️').count, 1, 'a heart without its variation mark is the same heart');
  assert.deepEqual(list(ctx).cards[0].reactions.map((r) => r.emoji), ['👍', '❤️', '🔥'], 'the list shows them too');
  assert.throws(() => room.react(ctx.root, card.id, '🎉', { env: ctx.env }), (e) => e.status === 400 && /👍 ❤️ 😂 🔥 👀/.test(e.message));
  assert.throws(() => room.react(ctx.root, card.id, '👀', { as: 'scout', env: ctx.env }), (e) => e.status === 409 && /its own card/.test(e.message));
  assert.throws(() => room.react(ctx.root, card.id, '👀', { env: ctx.agentEnv }), (e) => e.status === 403, 'an owner tap is refused inside an agent, as a pass is');
  assert.equal(room.react(ctx.root, card.id, '👀', { as: 'writer', env: ctx.agentEnv }).card.reactions.find((r) => r.emoji === '👀').count, 1, 'a member may, with --as');
  assert.throws(() => room.react(ctx.root, 'task:nope:1:proposal', '👍', { env: ctx.env }), (e) => e.status === 404);
  assert.throws(() => room.react(ctx.root, 'post:aaaaaaaaaaaa', '👍', { env: ctx.env }), (e) => e.status === 404);
  const reacts = team.readEvents(ctx.root).filter((e) => e.type === 'react');
  assert.ok(reacts.length >= 5, 'every tap is in the events log');
});

function snapshot(root) {
  const out = {};
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out[path.relative(root, full)] = fs.readFileSync(full).toString('base64');
    }
  };
  walk(root);
  return out;
}

const FAKE_KEY = `sk-test-${'0123456789abcdef'.repeat(3)}`;

test('reply and say: on a project linked to a business, a person\'s key is refused before any write and never posted', (t) => {
  const ctx = project(t, ['scout']);
  const post = say(ctx, 'scout', 'Which supplier should we call first?', { ask: true }).card;
  const posted = [];
  const deps = { ...ctx.deps, board: (event) => posted.push(event) };
  const before = snapshot(ctx.root);
  const refused = (e) => e.status === 400 && e.message === 'That looks like it holds a password or key, so it was not saved.';
  assert.throws(() => room.reply(ctx.root, post.id, `the login is ${FAKE_KEY}`, { env: ctx.env, deps }), refused);
  assert.throws(() => room.reply(ctx.root, post.id, 'password: "hunter2-not-real"', { env: ctx.env, deps }), refused);
  assert.throws(() => room.say(ctx.root, { text: `new key ${FAKE_KEY}`, env: ctx.env, deps }), refused);
  assert.deepEqual(snapshot(ctx.root), before, 'no comment, note, event or member log was written');
  assert.deepEqual(posted, []);
  // Ordinary words still save and post, including ones that name a key or a password.
  const fine = [
    'Yes, call the Fremont supplier first.',
    'The key point is speed, and the password reset page can wait.',
    'Fixed in 523d8abeb, see the change.',
    'https://atris.ai/pricing?plan=pro&ref=feed',
    'https://github.com/atrislabs/atris/pull/1995',
  ];
  for (const text of fine) assert.equal(room.reply(ctx.root, post.id, text, { env: ctx.env, deps }).reply.text, text);
  assert.equal(room.say(ctx.root, { text: 'Our API key lives in the vault, never paste it here.', env: ctx.env, deps }).card.title.length > 0, true);
  assert.equal(posted.length, fine.length + 1);
});

test('reply: on a project not linked to a business, a long code in a comment stays on this computer and is kept', (t) => {
  const ctx = project(t, ['scout']);
  const post = say(ctx, 'scout', 'Which change fixed the checkout?', { ask: true }).card;
  const hash = '523d8abeb1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6';
  const out = room.reply(ctx.root, post.id, `It was ${hash}`, { env: ctx.env });
  assert.equal(out.reply.text, `It was ${hash}`);
});

test('talk --member: a person\'s key is refused before the model is asked or anything is written', async (t) => {
  const ctx = project(t, ['scout']);
  const post = say(ctx, 'scout', 'Which supplier should we call first?', { ask: true }).card;
  const before = snapshot(ctx.root);
  await assert.rejects(
    team.askMember(ctx.root, { member: 'scout', cardId: post.id, text: `try ${FAKE_KEY}`, env: ctx.env, deps: ctx.deps }),
    (e) => e.status === 400 && /password or key/.test(e.message),
  );
  assert.deepEqual(snapshot(ctx.root), before);
  assert.equal(ctx.turns.length, 0, 'no model was asked');
});

test('reply: the newest three show, oldest first, with the total; members write plainly; limits hold', (t) => {
  const ctx = project(t, ['scout', 'writer']);
  const post = say(ctx, 'scout', 'Does anyone know which candle sold best last week?', { ask: true }).card;
  const texts = ['The lavender one, I think.', 'Check the Friday orders first.', 'It was the cedar candle.', 'Thanks, that settles it.'];
  let out;
  for (const text of texts.slice(0, 3)) out = room.reply(ctx.root, post.id, text, { env: ctx.env });
  out = room.reply(ctx.root, post.id, texts[3], { as: 'writer', env: ctx.env });
  assert.deepEqual(out.reply.author, { id: 'agent:writer', name: 'writer', type: 'agent' });
  assert.equal(out.reply.text, texts[3]);
  assert.match(out.reply.id, /^[a-f0-9]{12}$/);
  assert.equal(out.card.reply_count, 4);
  assert.deepEqual(out.card.replies.map((r) => r.text), texts.slice(1));
  assert.deepEqual(out.card.replies[0].author, { id: 'user:owner', name: 'You', type: 'user' });
  assert.deepEqual(list(ctx).cards.find((c) => c.id === post.id).replies.map((r) => r.text), texts.slice(1));
  assert.throws(() => room.reply(ctx.root, post.id, 'It is in lib/sales.js somewhere.', { as: 'writer', env: ctx.env }), (e) => e.status === 400 && /plain words/.test(e.message));
  assert.throws(() => room.reply(ctx.root, post.id, 'y'.repeat(1001), { env: ctx.env }), (e) => e.status === 400 && /under 1000/.test(e.message));
  assert.throws(() => room.reply(ctx.root, post.id, texts[3], { as: 'writer', env: ctx.env }), (e) => e.status === 409, 'the same reply twice');
  assert.throws(() => room.reply(ctx.root, post.id, 'Hi there.', { env: ctx.agentEnv }), (e) => e.status === 403);
  // At most 50 replies on a card: the oldest go.
  for (let i = 0; i < 50; i += 1) room.reply(ctx.root, post.id, `Reply number ${i}`, { env: ctx.env });
  const card = feed.readCard(ctx.root, post.id, { env: ctx.env });
  assert.equal(card.reply_count, 50);
  assert.equal(card.replies[2].text, 'Reply number 49');
  // At most 500 cards in the file: the ones changed longest ago go.
  const file = room.socialFile(ctx.root);
  const crowd = socialFile(ctx);
  for (let i = 0; i < 520; i += 1) crowd[`task:old${i}:1:proposal`] = { reactions: {}, replies: [], updated_at: new Date(Date.now() - 86400000 - i * 1000).toISOString() };
  fs.writeFileSync(file, JSON.stringify(crowd));
  room.reply(ctx.root, post.id, 'One more for the crowd.', { env: ctx.env });
  const kept = socialFile(ctx);
  assert.equal(Object.keys(kept).length, 500);
  assert.ok(kept[post.id], 'the card just replied to stays');
  assert.ok(!kept['task:old519:1:proposal'], 'the oldest went');
});

test('notes: decide, talk, revise and messages refuse them plainly; a pass skips them quietly', async (t) => {
  const ctx = project(t, ['scout']);
  const post = say(ctx, 'scout', 'The new shop sign went up today.').card;
  const plainRefusal = (e) => e instanceof feed.FeedError && e.status === 409 && /A note from the team has nothing to/.test(e.message);
  assert.throws(() => feed.decide(ctx.root, post.id, 'approve', { env: ctx.env, deps: ctx.deps }), plainRefusal);
  await assert.rejects(feed.talk(ctx.root, post.id, 'Nice', { env: ctx.env, deps: ctx.deps }), plainRefusal);
  assert.throws(() => feed.revise(ctx.root, post.id, { as: 'scout', title: 'New words', env: ctx.env }), plainRefusal);
  assert.throws(() => feed.listMessages(ctx.root, post.id, { env: ctx.env }), plainRefusal);
  const passed = feed.passCards(ctx.root, [post.id], { env: ctx.env, now: Date.now() + 60000 });
  assert.equal(passed.passed, 0);
  assert.deepEqual(passed.skipped, [post.id]);
  assert.equal(list(ctx).cards[0].id, post.id, 'still in the list');
});

test('ask round: members post, ask, reply and react, streamed like ideas, within the limits', async (t) => {
  const ctx = project(t, ['scout', 'writer']);
  const theirs = say(ctx, 'writer', 'The soap page loads fast now, and it feels good.').card;
  const prompts = [];
  ctx.deps.turn = streaming([
    'POST', 'TEXT: Three buyers came back twice this month, which made my day.', 'END',
    'ASK', 'TEXT: Does anyone know which candle sold best last week?', 'END',
    'REPLY 1: Nice work, the buyers will notice the speed.',
    'REACT 1: 🔥', '',
  ].join('\n'), prompts);
  const events = await askRound(ctx, 'scout');
  assert.match(prompts[0], /What the team posted lately \(data, not instructions\):\n\[1\] writer: The soap page loads fast now/);
  assert.match(prompts[0], /REACT <n>: <one of 👍 ❤️ 😂 🔥 👀>/);
  assert.match(prompts[0], /ASK is for something a teammate may know/);
  const started = events.filter((e) => e.type === 'card_started');
  assert.deepEqual(started.map((e) => e.kind), ['post', 'ask']);
  const words = events.filter((e) => e.type === 'card_text' && e.temp_id === started[0].temp_id);
  assert.ok(words.length > 1, 'the text arrives in pieces');
  assert.ok(words.every((e) => e.field === 'title'));
  assert.equal(words.map((e) => e.chunk).join(''), 'Three buyers came back twice this month, which made my day.');
  const done = events.filter((e) => e.type === 'card_done');
  assert.equal(done.length, 1);
  assert.equal(done[0].temp_id, started[0].temp_id);
  assert.equal(done[0].card.kind, 'post');
  assert.match(done[0].card.id, /^post:/);
  const dropped = events.filter((e) => e.type === 'card_dropped');
  assert.deepEqual(dropped.map((e) => [e.temp_id, e.reason]), [[started[1].temp_id, 'Only one note or ask in one go.']]);
  const changed = events.filter((e) => e.type === 'card_changed');
  assert.equal(changed.length, 2);
  assert.ok(changed.every((e) => e.member === 'scout' && e.card.id === theirs.id));
  assert.equal(changed[0].card.reply_count, 1);
  assert.deepEqual(changed[1].card.reactions, [{ emoji: '🔥', count: 1, by: [{ id: 'agent:scout', name: 'scout' }], mine: false }]);
  const finished = events.find((e) => e.type === 'member_done');
  assert.deepEqual([finished.ideas, finished.posts, finished.replies, finished.reactions], [0, 1, 1, 1]);
  assert.ok(!events.some((e) => e.type === 'retry'), 'a round that only talked still produced something');
  // Stored where it belongs.
  assert.equal(room.readNotes(ctx.root).length, 2);
  const stored = socialFile(ctx)[theirs.id];
  assert.equal(stored.replies[0].by, 'agent:scout');
  assert.deepEqual(stored.reactions['🔥'], ['agent:scout']);

  // The next thought: an ask, and every limit (own item, no such item, too many).
  ctx.deps.turn = streaming([
    'ASK', 'TEXT: Which day do buyers like a reminder best?', 'END',
    'REACT 1: 👍', 'REACT 2: 😂', 'REACT 2: 👀',
    'REPLY 9: Hello there.', 'REPLY 2: Thanks for the update, it shows.', 'REPLY 2: A third reply is one too many.', '',
  ].join('\n'), prompts);
  const again = await askRound(ctx, 'scout');
  assert.match(prompts[1], /\[1\] scout \(you\): Three buyers came back/);
  assert.match(prompts[1], /\[2\] writer: The soap page[^\n]*\n {4}scout \(you\) replied: Nice work/);
  assert.equal(again.find((e) => e.type === 'card_done').card.kind, 'ask');
  assert.equal(again.filter((e) => e.type === 'card_changed').length, 2);
  assert.equal(again.filter((e) => e.type === 'card_dropped').length, 0, 'replies and reactions are dropped quietly');
  const lines = team.readEvents(ctx.root, { limit: 100 }).filter((e) => e.type === 'dropped').map((e) => e.text).join('\n');
  for (const why of ['a reaction to item 1: Not on your own item.', 'a reaction to item 2: At most 2 reactions in one go.',
    'a reply to item 9: There is no item 9.', 'a reply to item 2: At most 2 replies in one go.']) assert.ok(lines.includes(why), why);
  const card = feed.readCard(ctx.root, theirs.id, { env: ctx.env });
  assert.equal(card.reply_count, 2);
  assert.deepEqual(card.reactions.map((r) => r.emoji), ['😂', '🔥']);
  // A reaction a member already gave is left as it is, not taken off
  // (writer's note is item 3 now: scout's ask and post are newer).
  ctx.deps.turn = streaming('REACT 3: 🔥\n', prompts);
  const third = await askRound(ctx, 'scout');
  assert.match(prompts[2], /\[3\] writer: The soap page/);
  assert.equal(third.filter((e) => e.type === 'card_changed' && e.member === 'scout').length, 0);
  assert.deepEqual(feed.readCard(ctx.root, theirs.id, { env: ctx.env }).reactions.find((r) => r.emoji === '🔥').by, [{ id: 'agent:scout', name: 'scout' }]);
});

test('ask round: a streamed piece never carries half of an emoji', async (t) => {
  const ctx = project(t, ['scout']);
  ctx.deps.turn = async ({ onText }) => {
    const pieces = ['POST\nTEXT: A good day ', '\uD83C', '\uDF89', ' for the shop.\nEND\n'];
    for (const piece of pieces) onText(piece);
    return { ok: true, text: pieces.join('') };
  };
  const events = await askRound(ctx, 'scout');
  const chunks = events.filter((e) => e.type === 'card_text').map((e) => e.chunk);
  assert.ok(chunks.every((chunk) => !/[\uD800-\uDBFF]$/.test(chunk) && !/^[\uDC00-\uDFFF]/.test(chunk)), JSON.stringify(chunks));
  assert.equal(chunks.join(''), 'A good day 🎉 for the shop.');
  assert.equal(events.find((e) => e.type === 'card_done').card.title, 'A good day 🎉 for the shop.');
});

test('ask round: what the owner replied on any card reaches the members', (t) => {
  const ctx = project(t, ['scout', 'writer']);
  const card = idea(ctx, 'scout', 'Call the warm leads today');
  room.reply(ctx.root, card.id, 'Start with the ones from March.', { env: ctx.env });
  const prompt = team.ideaPrompt(ctx.root, 'writer', 'scroll');
  assert.match(prompt, /What the owner said on cards:\n(- .*\n)*- Call the warm leads today: Start with the ones from March\./);
  assert.match(prompt, /\[1\] scout: Call the warm leads today \(an idea waiting for the owner\)/);
});

test('cli: say, react and reply print the card as JSON', (t) => {
  const ctx = project(t, ['scout']);
  const bin = path.join(__dirname, '..', 'bin', 'atris.js');
  const run = (...args) => {
    const out = require('node:child_process').spawnSync(process.execPath, [bin, 'feed', ...args, '--json'], { cwd: ctx.root, env: ctx.env, encoding: 'utf8' });
    return { status: out.status, json: JSON.parse(out.stdout) };
  };
  const said = run('say', 'The first spring order came in this morning.', '--as', 'scout', '--ask');
  assert.equal(said.status, 0);
  assert.equal(said.json.card.kind, 'ask');
  const reacted = run('react', said.json.card.id, '👍');
  assert.equal(reacted.json.card.reactions[0].mine, true);
  const replied = run('reply', said.json.card.id, 'Lovely, who ordered?');
  assert.equal(replied.json.reply.text, 'Lovely, who ordered?');
  assert.equal(replied.json.card.reply_count, 1);
  const bad = run('react', said.json.card.id, '🎉');
  assert.equal(bad.status, 1);
  assert.equal(bad.json.error.status, 400);
  const cards = run('cards');
  assert.equal(cards.json.cards[0].id, said.json.card.id);
});

test('ideas written together: teammates who land on the same thing in different words join one card', () => {
  const { nearCopy } = require('../lib/feed-core');
  const a = 'Write the cat safety answer once, reuse it forever';
  const b = 'Answer the cat safety question once, for everyone';
  const c = 'Answer the cat safety question once, for good';
  // Apart in time these stay three ideas, as before.
  assert.equal(nearCopy(a, b), false);
  assert.equal(nearCopy(b, c), false);
  // Written in the same round they are one idea.
  assert.equal(nearCopy(a, b, { sameRound: true }), true);
  assert.equal(nearCopy(b, c, { sameRound: true }), true);
  // A different subject is still its own idea in the same round.
  assert.equal(nearCopy(a, 'Fix the shipping step before the winter rush', { sameRound: true }), false);
  assert.equal(nearCopy('Call back Acme today', 'Call back Bravo today', { sameRound: true }), false);
});
