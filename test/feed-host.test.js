'use strict';

// Atris hosts a post: it reads the person's words with the project and the
// team, picks up to two awake members whose roles fit, and asks each through
// the ordinary ask, so every answer is that member's own comment. Every model
// turn here is a stand-in; nothing real starts and nothing spends.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const feed = require('../lib/feed-core');
const room = require('../lib/feed-room');
const host = require('../lib/feed-host');
const decisionFeed = require('../commands/decision-feed');
const { project } = require('./helpers/feed-project');

const HOST = /You are Atris, the host of this project's feed/;

function withRoles(ctx, roles) {
  for (const [name, role] of Object.entries(roles)) {
    fs.writeFileSync(path.join(ctx.root, 'atris', 'team', name, 'MEMBER.md'), `---\nname: ${name}\nrole: ${role}\n---\n# ${name}\n\nWorks on ${role.toLowerCase()}.\n`);
  }
}

// The stand-in model: Atris answers with its pick lines, each member with its own sentence.
function answers(ctx, { pick = 'PICK writer: how the words land\nPICK closer: what a buyer would pay', member = null } = {}) {
  ctx.deps.answer = (prompt) => {
    if (HOST.test(prompt)) return typeof pick === 'function' ? pick(prompt) : pick;
    const me = /You are ([a-z]+), a member/.exec(prompt)[1];
    return member ? member(me, prompt) : `${me} thinks the first step is to ask three buyers.`;
  };
}

function post(ctx, text = 'I want to launch a candle subscription in December') {
  return room.say(ctx.root, { text, env: ctx.env, deps: ctx.deps }).card;
}

function discuss(ctx, id, extra = {}) {
  const events = [];
  return host.discuss(ctx.root, id, { env: ctx.env, deps: ctx.deps, inline: true, onEvent: (e) => events.push(e), ...extra }).then((out) => ({ out, events }));
}

function hostTurns(ctx) {
  return ctx.turns.filter((turn) => HOST.test(turn.prompt));
}

function memberTurns(ctx) {
  return ctx.turns.filter((turn) => !HOST.test(turn.prompt));
}

test('an older feed writer cannot erase the host state or start the same discussion twice', async (t) => {
  const ctx = project(t, ['writer']);
  ctx.env.ATRIS_FEED_MEMBER_GAP_SECONDS = '0';
  answers(ctx, { pick: 'PICK writer: the words' });
  const card = post(ctx);
  await discuss(ctx, card.id);
  const socialPath = room.socialFile(ctx.root);
  const social = JSON.parse(fs.readFileSync(socialPath, 'utf8'));
  // An old writer reconstructs an entry with only fields it understands.
  delete social[card.id].discussion;
  fs.writeFileSync(socialPath, JSON.stringify(social));
  const fresh = room.replies(ctx.root, card.id, { env: ctx.env });
  assert.equal(fresh.card.discussion.status, 'done');
  assert.equal(fresh.card.reply_count, 1);
  const replay = await discuss(ctx, card.id);
  assert.equal(replay.out.replayed, true);
  assert.equal(ctx.turns.length, 2, 'no duplicate model turns');
});

test('a recent post by the person is on the first feed page after reopening', (t) => {
  const ctx = project(t, ['writer']);
  for (let i = 0; i < 35; i += 1) room.say(ctx.root, { text: `Team note number ${i}.`, as: 'writer', env: ctx.env, deps: ctx.deps, fromAsk: true });
  const card = post(ctx, 'What should we do next?');
  const listed = feed.listCards(ctx.root, { env: ctx.env, limit: 5 }).cards;
  assert.equal(listed[0].id, card.id);
});

test('a post: Atris picks two fitting members by role, each answers once as its own comment, and the card says so', async (t) => {
  const ctx = project(t, ['scout', 'writer', 'closer']);
  ctx.env.ATRIS_FEED_MEMBER_GAP_SECONDS = '0';
  withRoles(ctx, { scout: 'Finds new leads', writer: 'Writes the words customers read', closer: 'Prices and closes sales' });
  answers(ctx);
  const card = post(ctx);
  const { out, events } = await discuss(ctx, card.id);
  assert.equal(out.started, true);
  assert.equal(hostTurns(ctx).length, 1, 'one pick turn');
  assert.equal(memberTurns(ctx).length, 2, 'one answer each');
  const prompt = hostTurns(ctx)[0].prompt;
  assert.match(prompt, /Post: I want to launch a candle subscription in December/);
  assert.match(prompt, /- writer: Writes the words customers read/);
  assert.match(prompt, /- closer: Prices and closes sales/);
  assert.match(prompt, /Project goal: none set yet/, 'a new project says it has no goal, never one made up');
  assert.match(prompt, /Do not invent goals, facts or team members/);
  // Each member is told why it was brought in; the second reads the first one's answer.
  const [first, second] = memberTurns(ctx).map((turn) => turn.prompt);
  assert.match(first, /You are writer[\s\S]*Atris, the host of the feed, brought you into the discussion on the owner's post for this: how the words land/);
  assert.match(second, /You are closer[\s\S]*for this: what a buyer would pay/);
  assert.match(second, /writer: writer thinks the first step is to ask three buyers\./);
  const saved = room.replies(ctx.root, card.id, { env: ctx.env }).replies;
  assert.deepEqual(saved.map((r) => [r.author.id, r.text]), [
    ['agent:writer', 'writer thinks the first step is to ask three buyers.'],
    ['agent:closer', 'closer thinks the first step is to ask three buyers.'],
  ]);
  const d = feed.readCard(ctx.root, card.id, { env: ctx.env }).discussion;
  assert.equal(d.status, 'done');
  assert.equal(d.round, 1);
  assert.deepEqual(d.picks.map((p) => [p.member, p.status, p.angle]), [['writer', 'answered', 'how the words land'], ['closer', 'answered', 'what a buyer would pay']]);
  assert.equal(d.can_retry, false);
  assert.deepEqual(events.filter((e) => ['choosing', 'picked', 'asking', 'answered', 'done'].includes(e.type)).map((e) => e.type),
    ['choosing', 'picked', 'asking', 'answered', 'asking', 'answered', 'done']);
  // It stays: a fresh read of the whole feed carries the post, its answers and Atris's line.
  const listed = feed.listCards(ctx.root, { env: ctx.env }).cards.find((c) => c.id === card.id);
  assert.equal(listed.reply_count, 2);
  assert.equal(listed.discussion.status, 'done');
  assert.equal(ctx.spawned.length, 0, 'no work started');
  assert.equal(ctx.thinkers.length, 0, 'no one else woken');
});

test('the same words never ask twice; a member answering starts nothing; only the person\'s next words start the next round', async (t) => {
  const ctx = project(t, ['writer', 'closer']);
  ctx.env.ATRIS_FEED_MEMBER_GAP_SECONDS = '0';
  answers(ctx, { pick: 'PICK writer: the words' });
  const card = post(ctx);
  await discuss(ctx, card.id);
  assert.equal(ctx.turns.length, 2);
  let { out } = await discuss(ctx, card.id);
  assert.equal(out.started, false);
  assert.equal(out.replayed, true);
  assert.equal(ctx.turns.length, 2, 'asked again with the same words: no turn');
  room.reply(ctx.root, card.id, 'I can add the spring scent too.', { as: 'closer', env: ctx.env, deps: ctx.deps });
  ({ out } = await discuss(ctx, card.id));
  assert.equal(out.replayed, true, 'a member\'s comment is not the person\'s words');
  assert.equal(ctx.turns.length, 2);
  // The person steers: one more round, about the newest words.
  room.reply(ctx.root, card.id, 'Keep it under twenty dollars a month.', { env: ctx.env });
  ({ out } = await discuss(ctx, card.id));
  assert.equal(out.started, true);
  assert.equal(ctx.turns.length, 4);
  assert.match(hostTurns(ctx)[1].prompt, /The owner's newest words: Keep it under twenty dollars a month\./);
  assert.match(hostTurns(ctx)[1].prompt, /The owner: Keep it under twenty dollars a month\./);
  assert.equal(out.discussion.round, 2);
});

test('Atris may only pick awake members on this team; a made-up or sleeping name is dropped; no fit says so', async (t) => {
  const ctx = project(t, ['writer', 'closer', 'scout']);
  require('../lib/member-switches').setMemberAwake('scout', false, ctx.root);
  answers(ctx, { pick: 'PICK ghost: a stranger\nPICK scout: leads\nPICK writer: the words\nPICK writer: again\nPICK closer: price\nPICK closer: price' });
  let card = post(ctx);
  await discuss(ctx, card.id);
  assert.doesNotMatch(hostTurns(ctx)[0].prompt, /- scout:/, 'a sleeping member is not offered');
  assert.deepEqual(feed.readCard(ctx.root, card.id, { env: ctx.env }).discussion.picks.map((p) => p.member), ['writer', 'closer']);
  assert.equal(memberTurns(ctx).length, 2, 'never more than two');

  answers(ctx, { pick: 'PICK ghost: a stranger\nPICK scout: leads' });
  card = post(ctx, 'What should the shop sign say?');
  const before = ctx.turns.length;
  await discuss(ctx, card.id);
  let d = feed.readCard(ctx.root, card.id, { env: ctx.env }).discussion;
  assert.equal(d.status, 'failed');
  assert.match(d.message, /did not name anyone on this team/);
  assert.equal(ctx.turns.length, before + 1, 'no member asked');

  answers(ctx, { pick: 'NONE: nobody here handles legal questions' });
  card = post(ctx, 'Do we need a lawyer for the lease?');
  await discuss(ctx, card.id);
  d = feed.readCard(ctx.root, card.id, { env: ctx.env }).discussion;
  assert.equal(d.status, 'no_fit');
  assert.match(d.message, /No one on the team fits this yet: nobody here handles legal questions/);
  assert.equal(d.picks.length, 0);
});

test('no team, or no one awake: said plainly, nothing runs, nothing is pretended', async (t) => {
  const ctx = project(t, []);
  answers(ctx);
  const card = post(ctx);
  const { out } = await discuss(ctx, card.id);
  assert.equal(out.started, false);
  assert.equal(out.discussion.status, 'no_team');
  assert.match(out.discussion.message, /no team yet, so no one was asked/);
  assert.equal(ctx.turns.length, 0);
  assert.equal(room.replies(ctx.root, card.id, { env: ctx.env }).reply_count, 0);

  const asleep = project(t, ['writer'], { on: false });
  answers(asleep);
  const other = post(asleep);
  const again = await discuss(asleep, other.id);
  assert.equal(again.out.discussion.status, 'no_one_awake');
  assert.match(again.out.discussion.message, /No one on the team is awake/);
  assert.equal(again.out.discussion.can_retry, true);
  assert.equal(asleep.turns.length, 0);
  // Woken, the same post can be brought to the team; it never ran, so it never counted.
  require('../lib/member-switches').setMemberAwake('writer', true, asleep.root);
  answers(asleep, { pick: 'PICK writer: the words' });
  const woke = await discuss(asleep, other.id);
  assert.equal(woke.out.started, true);
  assert.equal(woke.out.discussion.status, 'done');
  assert.equal(woke.out.discussion.round, 1);
});

test('awake members whose model cannot run here: said as that, not as asleep, and nothing runs', async (t) => {
  const ctx = project(t, ['writer'], { engine: 'not-a-model' });
  answers(ctx);
  const card = post(ctx);
  const { out } = await discuss(ctx, card.id);
  assert.equal(out.discussion.status, 'no_one_awake');
  assert.match(out.discussion.message, /model cannot run on this computer/);
  assert.equal(ctx.turns.length, 0);
});

test('a failed pick is visible with a retry; it runs again only when the person asks, and a failed member does not hide the other', async (t) => {
  const ctx = project(t, ['writer', 'closer']);
  ctx.env.ATRIS_FEED_MEMBER_GAP_SECONDS = '0';
  const turn = ctx.deps.turn;
  ctx.deps.turn = async (args) => (HOST.test(args.prompt) ? (ctx.turns.push({ prompt: args.prompt }), { ok: false, error: 'model went away' }) : turn(args));
  const card = post(ctx);
  await discuss(ctx, card.id);
  let d = feed.readCard(ctx.root, card.id, { env: ctx.env }).discussion;
  assert.equal(d.status, 'failed');
  assert.match(d.message, /could not choose who should answer/);
  assert.equal(d.can_retry, true);
  assert.equal(ctx.turns.length, 1);
  await discuss(ctx, card.id);
  assert.equal(ctx.turns.length, 1, 'not run again by itself');
  ctx.deps.turn = turn;
  answers(ctx);
  // closer is busy thinking from somewhere else: its pick fails, writer still answers.
  const file = path.join(ctx.root, '.atris', 'state', 'feed', 'thinking-closer.json');
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
  await discuss(ctx, card.id, { retry: true });
  d = feed.readCard(ctx.root, card.id, { env: ctx.env }).discussion;
  assert.equal(d.status, 'done');
  assert.deepEqual(d.picks.map((p) => [p.member, p.status]), [['writer', 'answered'], ['closer', 'failed']]);
  assert.match(d.picks[1].error, /closer is already thinking/);
  assert.equal(ctx.deps.sleeps.filter((ms) => ms === 10000).length, 2, 'a busy member is waited for twice, then its pick fails');
  assert.equal(d.can_retry, true);
  assert.equal(d.round, 2, 'the retry counted');
});

test('a teammate who only asks a question back is not saved: its pick fails with that reason, counts for the day and is not asked again by itself', async (t) => {
  const ctx = project(t, ['writer', 'closer']);
  ctx.env.ATRIS_FEED_MEMBER_GAP_SECONDS = '0';
  answers(ctx, {
    pick: 'PICK writer: the words\nPICK closer: what a buyer would pay',
    member: (me) => (me === 'writer' ? 'Which month do you mean? Who is the buyer?' : 'Start with refills at twelve dollars a month. Does that work for you?'),
  });
  const card = post(ctx);
  await discuss(ctx, card.id);
  const saved = room.replies(ctx.root, card.id, { env: ctx.env }).replies;
  assert.deepEqual(saved.map((r) => [r.author.id, r.text]), [['agent:closer', 'Start with refills at twelve dollars a month. Does that work for you?']],
    'a real answer that ends with a question is saved; a question alone is not');
  const d = feed.readCard(ctx.root, card.id, { env: ctx.env }).discussion;
  assert.deepEqual(d.picks.map((p) => [p.member, p.status, p.error]), [['writer', 'failed', 'Only asked a question.'], ['closer', 'answered', null]]);
  const pings = JSON.parse(fs.readFileSync(path.join(ctx.root, '.atris', 'state', 'feed', 'pings.json'), 'utf8'));
  assert.equal(pings.members.writer.count, 1, 'the ask still counts against the day');
  assert.equal(memberTurns(ctx).length, 2, 'asked once each, no retry by itself');
  await discuss(ctx, card.id);
  assert.equal(memberTurns(ctx).length, 2, 'asking again with the same words runs nothing');
  // Asked directly by name, the same answer is refused the same way.
  await assert.rejects(require('../lib/feed-team').askMember(ctx.root, { member: 'writer', cardId: card.id, text: 'What do you think?', env: ctx.env, deps: ctx.deps }),
    (e) => e.code === 'only_question' && /only asked a question back/.test(e.message));
});

test('two posts at once: a member busy answering one is waited for, then answers the other', async (t) => {
  const ctx = project(t, ['writer']);
  ctx.env.ATRIS_FEED_MEMBER_GAP_SECONDS = '0';
  answers(ctx, { pick: 'PICK writer: the words' });
  const file = path.join(ctx.root, '.atris', 'state', 'feed', 'thinking-writer.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
  // The other answer finishes while this round waits.
  ctx.deps.sleep = async (ms) => { ctx.deps.sleeps.push(ms); if (ms === 10000) fs.rmSync(file, { force: true }); };
  const card = post(ctx);
  await discuss(ctx, card.id);
  const d = feed.readCard(ctx.root, card.id, { env: ctx.env }).discussion;
  assert.deepEqual(d.picks.map((p) => [p.member, p.status]), [['writer', 'answered']]);
  assert.equal(ctx.deps.sleeps.filter((ms) => ms === 10000).length, 1);
});

test('the day\'s limit holds Atris too: at the limit nothing runs and the card says when it resets', async (t) => {
  const ctx = project(t, ['writer']);
  answers(ctx);
  const card = post(ctx);
  await discuss(ctx, card.id, { env: { ...ctx.env, ATRIS_FEED_PINGS_PER_DAY: '0' } });
  const d = feed.readCard(ctx.root, card.id, { env: ctx.env }).discussion;
  assert.equal(d.status, 'failed');
  assert.match(d.message, /the most allowed\. It resets/);
  assert.equal(ctx.turns.length, 0);
});

test('one round at a time: words written while it runs wait, and only the newest start one more round, in the same runner', async (t) => {
  const ctx = project(t, ['writer', 'closer']);
  ctx.env.ATRIS_FEED_MEMBER_GAP_SECONDS = '0';
  const spawned = [];
  ctx.deps.spawnHost = (...args) => { spawned.push(args); return null; };
  let interrupted = false;
  let calls = 0;
  let card;
  answers(ctx, {
    pick: 'PICK writer: the words',
    member: (me) => {
      if (!interrupted) {
        interrupted = true;
        // The person writes twice while writer is answering, and asks each time.
        room.reply(ctx.root, card.id, 'Also think about gift boxes.', { env: ctx.env });
        room.reply(ctx.root, card.id, 'Actually, start with refills.', { env: ctx.env });
        const first = host.plan(ctx.root, card.id, { env: ctx.env });
        const second = host.plan(ctx.root, card.id, { env: ctx.env });
        assert.equal(first.started, false);
        assert.equal(first.queued, true);
        assert.equal(second.queued, true);
      }
      calls += 1;
      return `${me} has view number ${calls}.`;
    },
  });
  card = post(ctx);
  await discuss(ctx, card.id);
  assert.equal(spawned.length, 0, 'the waiting words never started a second runner');
  assert.equal(hostTurns(ctx).length, 2, 'the first round and one more');
  assert.match(hostTurns(ctx)[1].prompt, /The owner's newest words: Actually, start with refills\./);
  const d = feed.readCard(ctx.root, card.id, { env: ctx.env }).discussion;
  assert.equal(d.round, 2);
  assert.equal(d.queued, false);
  assert.equal(d.status, 'done');
});

test('at most five rounds a card, then a plain line; only a person may start one', async (t) => {
  const ctx = project(t, ['writer']);
  ctx.env.ATRIS_FEED_MEMBER_GAP_SECONDS = '0';
  let n = 0;
  answers(ctx, { pick: 'PICK writer: the words', member: () => `Answer number ${(n += 1)}.` });
  const card = post(ctx);
  await discuss(ctx, card.id);
  for (let i = 1; i <= 5; i += 1) {
    room.reply(ctx.root, card.id, `Follow up ${i}.`, { env: ctx.env });
    await discuss(ctx, card.id);
  }
  const d = feed.readCard(ctx.root, card.id, { env: ctx.env }).discussion;
  assert.equal(d.status, 'limit');
  assert.match(d.message, /5 times on this card, the most/);
  assert.equal(hostTurns(ctx).length, 5);
  await assert.rejects(host.discuss(ctx.root, card.id, { env: ctx.agentEnv, deps: ctx.deps, inline: true }),
    (e) => e instanceof feed.FeedError && e.status === 403 && /Only a person can bring the team/.test(e.message));
  const other = feed.proposeCard(ctx.root, { as: 'writer', title: 'Call the warm leads today', why: 'More people buy', env: ctx.env }).card;
  await assert.rejects(host.discuss(ctx.root, other.id, { env: ctx.env, deps: ctx.deps, inline: true }),
    (e) => e instanceof feed.FeedError && e.status === 409 && /nothing from you on this card/.test(e.message));
});

test('in the background: discuss plans and hands off once; one runner takes the round; a runner that died shows as stopped', async (t) => {
  const ctx = project(t, ['writer']);
  ctx.env.ATRIS_FEED_MEMBER_GAP_SECONDS = '0';
  const spawned = [];
  ctx.deps.spawnHost = (root, cardId, roundId) => { spawned.push({ root, cardId, roundId }); return 4242; };
  answers(ctx, { pick: 'PICK writer: the words' });
  const card = post(ctx);
  let out = await host.discuss(ctx.root, card.id, { env: ctx.env, deps: ctx.deps });
  assert.equal(out.started, true);
  assert.equal(out.discussion.status, 'choosing', 'the card says Atris is choosing at once');
  assert.equal(spawned.length, 1);
  assert.equal(ctx.turns.length, 0, 'nothing ran in the asking process');
  out = await host.discuss(ctx.root, card.id, { env: ctx.env, deps: ctx.deps });
  assert.equal(out.replayed, true);
  assert.equal(spawned.length, 1, 'asked again while it is starting: no second runner');
  const ran = await Promise.all([
    host.runRound(ctx.root, card.id, spawned[0].roundId, { env: ctx.env, deps: ctx.deps }),
    host.runRound(ctx.root, card.id, spawned[0].roundId, { env: ctx.env, deps: ctx.deps }),
  ]);
  assert.deepEqual(ran.map((r) => r.ran).sort(), [false, true]);
  assert.equal(hostTurns(ctx).length, 1);
  assert.equal(feed.readCard(ctx.root, card.id, { env: ctx.env }).discussion.status, 'done');

  // A runner that went away mid-round: shown as stopped, run again only on retry.
  room.reply(ctx.root, card.id, 'What about gift boxes?', { env: ctx.env });
  out = await host.discuss(ctx.root, card.id, { env: ctx.env, deps: ctx.deps });
  const round = spawned[1].roundId;
  const discussionFile = path.join(ctx.root, '.atris', 'state', 'feed', 'discussions.json');
  const discussions = JSON.parse(fs.readFileSync(discussionFile, 'utf8'));
  Object.assign(discussions[card.id].rounds.find((x) => x.id === round), { claimed: true, pid: 999999, status: 'asking' });
  fs.writeFileSync(discussionFile, JSON.stringify(discussions));
  const dead = { ...ctx.deps, isAlive: () => false };
  const d = feed.readCard(ctx.root, card.id, { env: ctx.env }).discussion;
  assert.equal(d.status, 'stopped');
  assert.match(d.message, /stopped before the team answered/);
  assert.equal(d.can_retry, true);
  out = await host.discuss(ctx.root, card.id, { env: ctx.env, deps: dead });
  assert.equal(out.replayed, true);
  assert.equal(spawned.length, 2, 'not started again by itself');
  out = await host.discuss(ctx.root, card.id, { env: ctx.env, deps: dead, retry: true });
  assert.equal(out.started, true);
  assert.equal(spawned.length, 3);
});

test('the command: atris feed discuss answers JSON at once, says it in its help, and a person\'s post holds 1000 characters', async (t) => {
  const ctx = project(t, ['writer']);
  const spawned = [];
  ctx.deps.spawnHost = (...args) => { spawned.push(args); return null; };
  const long = `${'We could sell refills by the jar. '.repeat(28)}`.trim();
  assert.ok(long.length > 280 && long.length <= 1000);
  const card = room.say(ctx.root, { text: long, env: ctx.env, deps: ctx.deps }).card;
  assert.equal(card.title, long);
  assert.throws(() => room.say(ctx.root, { text: 'x'.repeat(1001), env: ctx.env }), /under 1000/);
  assert.throws(() => room.say(ctx.root, { as: 'writer', text: 'y'.repeat(300), env: ctx.env }), /under 280/, 'a member\'s note stays short');
  const lines = [];
  const log = console.log;
  console.log = (line) => lines.push(String(line));
  let code;
  try {
    code = await decisionFeed.run(['discuss', '--json', '--', card.id], { cwd: ctx.root, env: ctx.env, deps: ctx.deps });
    await decisionFeed.run(['--help'], { cwd: ctx.root, env: ctx.env, deps: ctx.deps });
  } finally {
    console.log = log;
  }
  assert.equal(code, 0);
  const out = JSON.parse(lines[0]);
  assert.equal(out.version, 'atris.feed.v1');
  assert.equal(out.started, true);
  assert.equal(out.discussion.status, 'choosing');
  assert.equal(out.card.id, card.id);
  assert.equal(spawned.length, 1);
  assert.match(lines.join('\n'), /atris feed discuss <card> \[--retry\]/);
});

// ------------------------------------------------------------ naming a teammate with @

function tagRig(ctx) {
  ctx.env.ATRIS_FEED_MEMBER_GAP_SECONDS = '0';
  const runs = [];
  ctx.deps.spawnTagged = (_root, cardId, roundId) => { runs.push([cardId, roundId]); return null; };
  return runs;
}

test('naming a teammate with @ on any card: that teammate answers that comment once, right away, as an answer; never the work', async (t) => {
  const ctx = project(t, ['scout', 'writer', 'closer']);
  const runs = tagRig(ctx);
  answers(ctx, { member: (me) => `${me} says the plan is strong on reach but thin on price; I would test one price first.` });
  const idea = feed.proposeCard(ctx.root, { as: 'scout', title: 'Call the ten oldest leads', why: 'Old leads answer more often', env: ctx.env }).card;
  const said = room.reply(ctx.root, idea.id, '@closer can you review this plan?', { env: ctx.env, deps: ctx.deps });
  assert.deepEqual(said.tagged, ['closer'], 'the member who will answer');
  assert.equal(said.tag_note, undefined);
  assert.equal(runs.length, 1, 'asked at once, in the background');
  assert.equal(ctx.spawned.length, 0, 'a tag never starts the work');
  assert.equal(said.card.discussion.status, 'asking');
  await host.runTagged(ctx.root, ...runs[0], { env: ctx.env, deps: ctx.deps });
  assert.equal(memberTurns(ctx).length, 1);
  assert.equal(hostTurns(ctx).length, 0, 'Atris picks no one else');
  const prompt = memberTurns(ctx)[0].prompt;
  assert.match(prompt, /You are closer[\s\S]*named you in a comment/);
  assert.match(prompt, /The owner's comment: @closer can you review this plan\?/);
  assert.match(prompt, /Never answer only with a question/);
  const saved = room.replies(ctx.root, idea.id, { env: ctx.env }).replies;
  assert.deepEqual(saved.map((r) => r.author.type === 'user' ? 'you' : r.author.id), ['you', 'agent:closer']);
  assert.equal(saved[1].text, 'closer says the plan is strong on reach but thin on price; I would test one price first.');
  const d = feed.readCard(ctx.root, idea.id, { env: ctx.env }).discussion;
  assert.deepEqual([d.status, d.picks.map((p) => [p.member, p.status])], ['done', [['closer', 'answered']]]);
  // Once: the same round never runs again, and the person's next plain words do not bring Atris in on this card.
  assert.deepEqual(await host.runTagged(ctx.root, ...runs[0], { env: ctx.env, deps: ctx.deps }), { ran: false });
  room.reply(ctx.root, idea.id, 'Thanks, that helps.', { env: ctx.env, deps: ctx.deps });
  const after = await discuss(ctx, idea.id);
  assert.equal(after.out.started, false);
  assert.equal(ctx.turns.length, 1);
  // And the member cannot answer that comment twice by any path, even in other words.
  answers(ctx, { member: () => 'A second, different answer to the same comment.' });
  await assert.rejects(require('../lib/feed-team').askMember(ctx.root, { member: 'closer', cardId: idea.id, text: '', answering: { id: saved[0].id, text: saved[0].text }, env: ctx.env, deps: ctx.deps }), /already answered that comment/);
});

test('asking a member by name with words that name it: it answers there once and is not lined up again; another name is', async (t) => {
  const ctx = project(t, ['scout', 'writer', 'closer']);
  const runs = tagRig(ctx);
  answers(ctx, { member: (me) => `${me} would start with the oldest five leads.` });
  const idea = feed.proposeCard(ctx.root, { as: 'scout', title: 'Call the ten oldest leads', why: 'Old leads answer more often', env: ctx.env }).card;
  const team = require('../lib/feed-team');
  await team.askMember(ctx.root, { member: 'closer', cardId: idea.id, text: '@closer where should we start?', env: ctx.env, deps: ctx.deps });
  assert.equal(runs.length, 0, 'the member asked by name is not asked a second time in the background');
  assert.equal(memberTurns(ctx).length, 1);
  const saved = room.replies(ctx.root, idea.id, { env: ctx.env }).replies;
  assert.deepEqual(saved.map((r) => r.author.type === 'user' ? 'you' : r.author.id), ['you', 'agent:closer']);
  // Another member the same words name is still brought in, once.
  answers(ctx, { member: (me) => `${me} would pick the five who opened last month's note.` });
  await team.askMember(ctx.root, { member: 'closer', cardId: idea.id, text: '@closer @writer and which five first?', env: ctx.env, deps: ctx.deps });
  assert.equal(runs.length, 1);
  const d = feed.readCard(ctx.root, idea.id, { env: ctx.env }).discussion;
  assert.deepEqual(d.picks.map((p) => p.member), ['writer']);
});

test('several names: each named member answers once, in turn; an unknown name stays plain text; a sleeping one is said plainly', async (t) => {
  const ctx = project(t, ['scout', 'writer', 'closer']);
  const runs = tagRig(ctx);
  answers(ctx, { member: (me) => `${me} would keep the first offer small.` });
  require('../lib/member-switches').setMemberAwake('scout', false, ctx.root);
  const card = post(ctx);
  const said = room.reply(ctx.root, card.id, 'What do @Writer and @closer, and @nobody, think? Also @scout.', { env: ctx.env, deps: ctx.deps });
  assert.deepEqual(said.tagged, ['writer', 'closer']);
  assert.match(said.tag_note, /^scout is asleep or cannot run here, so it will not answer\. Wake it to ask\.$/);
  assert.equal(said.reply.text, 'What do @Writer and @closer, and @nobody, think? Also @scout.', 'kept as written');
  assert.equal(runs.length, 1, 'one round for the comment');
  // The person's comment on a post also goes to Atris (the desktop asks it): the named members answer, no one else.
  const asked = await discuss(ctx, card.id);
  assert.equal(asked.out.started, false);
  await host.runTagged(ctx.root, ...runs[0], { env: ctx.env, deps: ctx.deps });
  assert.equal(hostTurns(ctx).length, 0);
  const saved = room.replies(ctx.root, card.id, { env: ctx.env }).replies.slice(1);
  assert.deepEqual(saved.map((r) => [r.author.id, r.text]), [['agent:writer', 'writer would keep the first offer small.'], ['agent:closer', 'closer would keep the first offer small.']]);
  assert.match(memberTurns(ctx)[1].prompt, /writer: writer would keep the first offer small\./, 'the second reads the first');
  // No name the team knows: a plain comment, nobody asked.
  const plain = room.reply(ctx.root, card.id, 'Mail me at a@writer.com or ask @nobody.', { env: ctx.env, deps: ctx.deps });
  assert.deepEqual(plain.tagged, []);
  assert.equal(runs.length, 1);
});

test('a named member who only asks a question back: nothing is saved, the card says so, and --retry asks the same member again', async (t) => {
  const ctx = project(t, ['writer', 'closer']);
  const runs = tagRig(ctx);
  let reply = 'What budget do you have in mind?';
  answers(ctx, { member: () => reply });
  const card = post(ctx);
  room.reply(ctx.root, card.id, '@writer review this please', { env: ctx.env, deps: ctx.deps });
  await host.runTagged(ctx.root, ...runs[0], { env: ctx.env, deps: ctx.deps });
  let d = feed.readCard(ctx.root, card.id, { env: ctx.env }).discussion;
  assert.deepEqual([d.status, d.picks[0].status, d.picks[0].error, d.can_retry], ['failed', 'failed', 'Only asked a question.', true]);
  assert.equal(room.replies(ctx.root, card.id, { env: ctx.env }).reply_count, 1, 'only the person\'s comment');
  reply = 'Keep it short and lead with the price.';
  await discuss(ctx, card.id, { retry: true });
  d = feed.readCard(ctx.root, card.id, { env: ctx.env }).discussion;
  assert.deepEqual([d.status, d.picks.map((p) => [p.member, p.status])], ['done', [['writer', 'answered']]]);
  assert.equal(hostTurns(ctx).length, 0);
});

test('the command: atris feed reply --json says who will answer in "tagged"', async (t) => {
  const ctx = project(t, ['writer']);
  tagRig(ctx);
  const card = post(ctx);
  const lines = [];
  const log = console.log;
  console.log = (line) => lines.push(String(line));
  try {
    await decisionFeed.run(['reply', card.id, '@writer thoughts?', '--json'], { cwd: ctx.root, env: ctx.env, deps: ctx.deps });
    await decisionFeed.run(['reply', card.id, 'no names here', '--json'], { cwd: ctx.root, env: ctx.env, deps: ctx.deps });
  } finally {
    console.log = log;
  }
  const [first, second] = lines.map((line) => JSON.parse(line));
  assert.deepEqual(first.tagged, ['writer']);
  assert.equal(first.reply.text, '@writer thoughts?');
  assert.deepEqual(second.tagged, []);
});
