'use strict';

// A discussion on a card moves forward and ends: a teammate's comment says
// what it is and never only asks, a card takes a few comments, the one who
// asked writes the outcome with a next owner, and one lesson is kept. And the
// feed never lands on a costly model unless a person picked it for the feed.
// Every model here is a stand-in.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const feed = require('../lib/feed-core');
const team = require('../lib/feed-team');
const room = require('../lib/feed-room');
const rules = require('../lib/feed-outcome');
const work = require('../lib/feed-work');
const digest = require('../lib/feed-digest');
const { project } = require('./helpers/feed-project');

const ASK = 'Can we show a new buyer a real example of an order that kept moving overnight?';

function ask(ctx, as = 'asker') {
  return room.say(ctx.root, { as, text: ASK, ask: true, env: ctx.env, deps: ctx.deps }).card;
}

function streaming(text, prompts = []) {
  return async ({ prompt, onText }) => {
    prompts.push(prompt);
    for (const piece of text.match(/.{1,5}/gs) || []) onText(piece);
    return { ok: true, text };
  };
}

async function thought(ctx, member, lines, prompts = []) {
  ctx.deps.turn = streaming(`${lines.join('\n')}\n`, prompts);
  const events = [];
  await team.pingStream(ctx.root, { member, reason: 'scroll', noRetry: true, env: ctx.env, deps: ctx.deps, onEvent: (e) => events.push(e) });
  return events;
}

function comment(ctx, cardId, as, kind, text, source) {
  return room.reply(ctx.root, cardId, text, { as, team: true, fromAsk: true, kind, source, env: ctx.env, deps: ctx.deps });
}

const refused = (pattern) => (e) => e instanceof feed.FeedError && e.status === 409 && pattern.test(e.message);
const droppedLines = (ctx) => team.readEvents(ctx.root, { limit: 200 }).filter((e) => e.type === 'dropped').map((e) => e.text).join('\n');
const read = (ctx, id) => feed.readCard(ctx.root, id, { env: ctx.env });

test('a reply that is only a question is thrown away; one that found something is saved with where', async (t) => {
  const ctx = project(t, ['asker', 'scout']);
  const card = ask(ctx);
  const prompts = [];
  const first = await thought(ctx, 'scout', [
    'REPLY 1: Could the example show a dated record of what finished?',
    'REPLY 1: IDEA: Can we also show what was still running?',
  ], prompts);
  assert.equal(first.filter((e) => e.type === 'card_changed').length, 0, 'nothing was saved');
  assert.equal(read(ctx, card.id).reply_count, 0);
  const why = droppedLines(ctx);
  assert.match(why, /a reply to item 1: A comment starts with Found, Idea, Did or Disagree\./);
  assert.match(why, /a reply to item 1: A comment that is only a question is not saved\. Look it up/);
  assert.match(prompts[0], /A REPLY never asks a question\./);
  assert.match(prompts[0], /REPLY <n>: <KIND>:/);

  const second = await thought(ctx, 'scout', ['REPLY 1: FOUND: Every finished order already gets a dated line the buyer can open. FROM: the order notes']);
  assert.equal(second.filter((e) => e.type === 'card_changed').length, 1);
  const saved = read(ctx, card.id).replies[0];
  assert.deepEqual([saved.kind, saved.source, saved.text], ['found', 'the order notes', 'Every finished order already gets a dated line the buyer can open.']);
  // Found with no where is not a finding.
  assert.throws(() => comment(ctx, card.id, 'asker', 'found', 'Orders keep moving overnight.'), refused(/Found needs where you found it/));
});

test('the rules by themselves: what counts as only a question, and how a comment is read', () => {
  assert.equal(rules.onlyQuestion('Could the example show a dated record?'), true);
  assert.equal(rules.onlyQuestion('Can we show it? And what about updates?'), true);
  assert.equal(rules.onlyQuestion('The record is dated already. Should the buyer see it first?'), false);
  assert.equal(rules.onlyQuestion('Show the dated record first.'), false);
  assert.deepEqual(rules.parseComment('disagree - A demo is slower than a real order.'), { kind: 'disagree', text: 'A demo is slower than a real order.', source: null });
  assert.deepEqual(rules.parseComment('Found: It works | FROM: Tuesday notes.'), { kind: 'found', text: 'It works.', source: 'Tuesday notes' });
  assert.equal(rules.parseComment('Nice work everyone.').kind, null);
});

test('a card takes three team comments, nobody twice in a row, and a second one only with something found or done', (t) => {
  const ctx = project(t, ['asker', 'scout', 'writer', 'closer']);
  const card = ask(ctx);
  comment(ctx, card.id, 'scout', 'idea', 'Use last night\'s candle order as the example, it is real.');
  assert.throws(() => comment(ctx, card.id, 'scout', 'idea', 'And add the soap order beside it.'), refused(/Not twice in a row/));
  comment(ctx, card.id, 'writer', 'disagree', 'One order is too thin, show the whole night instead.');
  assert.throws(() => comment(ctx, card.id, 'scout', 'idea', 'Then show both side by side.'), refused(/You already said your piece/));
  comment(ctx, card.id, 'scout', 'found', 'Six orders moved while the shop was closed last night.', 'the order notes');
  assert.throws(() => comment(ctx, card.id, 'closer', 'idea', 'Open with the six orders.'), refused(/already has 3 comments from the team, the most\. It is time for the outcome/));
  assert.equal(read(ctx, card.id).reply_count, 3);
  // The team is told the card is full and what the three comments were, never only the last two.
  const prompt = team.ideaPrompt(ctx.root, 'closer', 'scroll');
  assert.match(prompt, /scout replied \(Idea\): Use last night's candle order/);
  assert.match(prompt, /writer replied \(Disagree\): One order is too thin/);
  assert.match(prompt, /scout replied \(Found\): Six orders moved[^\n]*\(from the order notes\)/);
  assert.match(prompt, /\(3 team comments, the most: no more replies, only its outcome\)/);
  // The owner speaking opens room for the team again.
  room.reply(ctx.root, card.id, 'Show me the six.', { env: ctx.env });
  comment(ctx, card.id, 'closer', 'idea', 'Open with the six orders, newest first.');
  assert.equal(read(ctx, card.id).reply_count, 5);
});

test('the one who asked closes the discussion: the answer, one next step, who has it next, and a lesson the team keeps', async (t) => {
  const ctx = project(t, ['asker', 'scout', 'writer']);
  const card = ask(ctx);
  // Nothing to close before anyone spoke.
  assert.doesNotMatch(team.ideaPrompt(ctx.root, 'asker', 'scroll'), /Close the discussion on/);
  comment(ctx, card.id, 'scout', 'found', 'Six orders moved while the shop was closed last night.', 'the order notes');
  // Only the one who asked is told to close it, and only it can.
  assert.doesNotMatch(team.ideaPrompt(ctx.root, 'writer', 'scroll'), /Close the discussion on/);
  const stranger = await thought(ctx, 'writer', ['OUTCOME 1', 'ANSWER: Yes, we can show it.', 'NEXT: Build the example.', 'OWNER: writer', 'END']);
  assert.equal(stranger.filter((e) => e.type === 'card_changed').length, 0);
  assert.match(droppedLines(ctx), /an outcome for item 1: The one who asked writes the outcome\./);
  assert.equal(read(ctx, card.id).outcome, null);

  const prompts = [];
  const closed = await thought(ctx, 'asker', [
    'OUTCOME 1',
    'ANSWER: Yes. Six orders moved while the shop was closed last night, and each has a dated line a buyer can open.',
    'NEXT: Put those six orders on one page for the new buyer',
    'OWNER: writer',
    'LESSON: Look in the order notes before asking the team whether something happened.',
    'END',
  ], prompts);
  assert.match(prompts[0], /Close the discussion on \[1\] now, before anything else/);
  assert.match(prompts[0], /OWNER: <who has it next, one of: asker, scout, writer, or owner>/);
  const done = closed.find((e) => e.type === 'member_done');
  assert.equal(done.outcomes, 1);
  const after = read(ctx, card.id);
  assert.equal(after.outcome.answer, 'Yes. Six orders moved while the shop was closed last night, and each has a dated line a buyer can open.');
  assert.equal(after.outcome.next, 'Put those six orders on one page for the new buyer');
  assert.deepEqual(after.outcome.owner, { id: 'agent:writer', name: 'writer', type: 'agent' });
  assert.equal(after.outcome.by.name, 'asker');
  assert.equal(after.outcome.needs_you, null);
  const last = after.replies[after.replies.length - 1];
  assert.deepEqual([last.kind, last.id], ['outcome', after.outcome.reply_id]);
  // The lesson sits where every teammate reads before it thinks.
  assert.ok(digest.listNotes(ctx.root, { member: 'scout' }).some((n) => n.scope === 'team' && /Look in the order notes before asking/.test(n.text)));
  assert.match(team.ideaPrompt(ctx.root, 'scout', 'scroll'), /Look in the order notes before asking the team/);
  // Closed: no more team comments, a second outcome is refused, and the team sees how it ended.
  assert.throws(() => comment(ctx, card.id, 'writer', 'idea', 'One more thought on the page.'), refused(/This discussion is closed/));
  assert.throws(() => rules.close(ctx.root, card.id, { answer: 'Again.', next: 'Do it.', owner: 'scout' }, { as: 'asker', env: ctx.env, deps: ctx.deps }), refused(/already closed/));
  const seen = team.ideaPrompt(ctx.root, 'scout', 'scroll');
  assert.match(seen, /\[1\] asker asked: Can we show a new buyer[^\n]*\(closed: no more replies\)/);
  assert.match(seen, /outcome, by asker: Yes\. Six orders moved[^\n]*Next: Put those six orders on one page for the new buyer \(writer has it next\)/);
  assert.doesNotMatch(team.ideaPrompt(ctx.root, 'asker', 'scroll'), /Close the discussion on/);

  // One action, on the outcome: it becomes the next step, as work for the one named.
  const started = work.startWork(ctx.root, card.id, { replyId: after.outcome.reply_id, env: ctx.env, deps: ctx.deps });
  assert.equal(started.work.member, 'writer');
  const made = feed.readCard(ctx.root, started.work.card_id, { env: ctx.env });
  assert.equal(made.title, 'Put those six orders on one page for the new buyer.');
  assert.equal(made.author.name, 'writer');

  // The owner speaking opens it again; the old outcome stays in the comments.
  room.reply(ctx.root, card.id, 'Make it seven.', { env: ctx.env });
  assert.equal(read(ctx, card.id).outcome, null);
});

test('only what needs the owner reaches the owner: one question, at most three choices, and the card is theirs first', (t) => {
  const ctx = project(t, ['asker', 'scout']);
  const card = ask(ctx);
  comment(ctx, card.id, 'scout', 'idea', 'Show the whole night as one short list.');
  const fields = { answer: 'We can show the whole night as one list.', next: 'Write the list for the buyer.', owner: 'scout', ask_owner: 'Which night should we show?', choices: 'Last night | The busiest night | A quiet night | A fourth night' };
  assert.throws(() => rules.close(ctx.root, card.id, { ...fields, owner: 'nobody-here' }, { as: 'asker', env: ctx.env, deps: ctx.deps }), refused(/needs an owner on this team, or the owner/));
  assert.throws(() => rules.close(ctx.root, card.id, { ...fields, answer: 'Should we show it?' }, { as: 'asker', env: ctx.env, deps: ctx.deps }), refused(/The answer of an outcome says something/));
  assert.throws(() => rules.close(ctx.root, card.id, { ...fields, next: '' }, { as: 'asker', env: ctx.env, deps: ctx.deps }), refused(/needs the one next step/));
  const out = rules.close(ctx.root, card.id, fields, { as: 'asker', env: ctx.env, deps: ctx.deps }).card.outcome;
  assert.deepEqual(out.needs_you, { question: 'Which night should we show?', choices: ['Last night', 'The busiest night', 'A quiet night'] });
  assert.deepEqual(out.owner, { id: 'owner', name: 'You', type: 'user' });
  assert.equal(out.after.name, 'scout');
  // The owner picks: the card stays closed and goes to the teammate with the next step.
  const picked = room.reply(ctx.root, card.id, 'The busiest night', { env: ctx.env }).card.outcome;
  assert.deepEqual([picked.needs_you, picked.decided, picked.owner.name, picked.after], [null, 'The busiest night', 'scout', null]);
  assert.throws(() => comment(ctx, card.id, 'scout', 'idea', 'One more thought.'), refused(/This discussion is closed/));
});

test('an outcome cut off by a broken answer is never trusted, and a forgotten END still closes a whole one', async (t) => {
  const ctx = project(t, ['asker', 'scout']);
  const card = ask(ctx);
  comment(ctx, card.id, 'scout', 'idea', 'Show the whole night as one short list.');
  ctx.deps.turn = async ({ onText }) => {
    const text = 'OUTCOME 1\nANSWER: Yes, show the whole night.\nNEXT: Write the li';
    onText(text);
    return { ok: false, text, error: 'the connection dropped' };
  };
  await team.pingStream(ctx.root, { member: 'asker', reason: 'scroll', env: ctx.env, deps: ctx.deps, onEvent: () => {} });
  assert.equal(read(ctx, card.id).outcome, null);
  await thought(ctx, 'asker', ['OUTCOME 1', 'ANSWER: Yes, show the whole night.', 'NEXT: Write the list for the buyer.', 'OWNER: scout', 'REACT 1: 👍']);
  assert.equal(read(ctx, card.id).outcome.owner.name, 'scout');
});

test('a teammate with a discussion to close is asked before everyone else', (t) => {
  const ctx = project(t, ['asker', 'scout', 'writer', 'closer', 'extra']);
  team.setLimit(ctx.root, 'member-gap-seconds', '0', { env: ctx.env });
  // asker was asked a moment ago, so by rotation it would go last.
  team.ping(ctx.root, { member: 'asker', reason: 'scroll', env: ctx.env, deps: ctx.deps });
  const before = team.ping(ctx.root, { reason: 'scroll', env: ctx.env, deps: ctx.deps }).plan.targets.map((x) => x.name);
  assert.ok(!before.includes('asker'), 'rotation alone leaves the one just asked out');
  const card = ask(ctx);
  comment(ctx, card.id, 'scout', 'idea', 'Show the whole night as one short list.');
  team.ping(ctx.root, { member: 'asker', reason: 'scroll', env: ctx.env, deps: ctx.deps });
  const after = team.ping(ctx.root, { reason: 'scroll', env: ctx.env, deps: ctx.deps }).plan.targets.map((x) => x.name);
  assert.equal(after[0], 'asker');
});

// ------------------------------------------------------------ which model

test('with no choice made the feed runs on Codex here, else Atris fast, and never on a costly model', (t) => {
  const ctx = project(t, ['scout', 'writer'], { engine: null });
  // The workspace's saved engine, chosen for other work, names the costliest one.
  fs.mkdirSync(path.join(ctx.root, '.atris'), { recursive: true });
  fs.writeFileSync(path.join(ctx.root, '.atris', 'engine.json'), JSON.stringify({ default: 'fable' }));
  const withCodex = { env: { ...ctx.env, ATRIS_FEED_INSTALLED: 'codex,claude' } };
  const noCodex = { env: { ...ctx.env, ATRIS_FEED_INSTALLED: 'claude' } };
  assert.deepEqual([team.memberEngine(ctx.root, 'scout', withCodex).id, team.memberEngine(ctx.root, 'scout', withCodex).source], ['codex', 'house']);
  assert.equal(team.memberEngine(ctx.root, 'scout', noCodex).id, 'atris-fast');
  assert.equal(team.memberEngine(ctx.root, '__atris_host__', noCodex).id, 'atris-fast', 'the host that picks who comments, too');
  assert.equal(team.settingsView(ctx.root, noCodex).engine_in_effect, 'atris-fast');
  // A member whose own line names a costly model for its normal work does not bring it into the feed.
  for (const costly of ['fable', 'claude']) {
    fs.writeFileSync(path.join(ctx.root, 'atris', 'ROSTER.md'), `# roster\n\n## team\n- scout: ${costly}\n- writer: haiku\n`);
    for (const options of [withCodex, noCodex]) {
      const picked = team.memberEngine(ctx.root, 'scout', options);
      assert.ok(!team.COSTLY.has(picked.id), `${costly} is not carried in (${picked.id})`);
      assert.equal(picked.skipped, costly);
    }
  }
  assert.deepEqual([team.memberEngine(ctx.root, 'writer', withCodex).id, team.memberEngine(ctx.root, 'writer', withCodex).source], ['haiku', 'member']);
  assert.equal(team.memberEngine(ctx.root, 'scout', withCodex).id, 'codex');
});

test('a person\'s own pick for the feed is honoured: for one ask, for one member, or as the feed default', async (t) => {
  const ctx = project(t, ['scout', 'writer'], { engine: null });
  const options = { env: { ...ctx.env, ATRIS_FEED_INSTALLED: 'codex,claude' } };
  // One ask.
  assert.deepEqual([team.memberEngine(ctx.root, 'scout', { ...options, pick: 'fable' }).id, team.memberEngine(ctx.root, 'scout', { ...options, pick: 'fable' }).source], ['fable', 'ask']);
  assert.equal(team.memberEngine(ctx.root, 'scout', { ...options, pick: 'no-such-model' }).available, false);
  const card = room.say(ctx.root, { text: 'How do we bring buyers back?', env: ctx.env, deps: ctx.deps }).card;
  await team.askMember(ctx.root, { member: 'scout', cardId: card.id, text: 'What would you try first?', engine: 'fable', env: ctx.env, deps: ctx.deps });
  assert.equal(ctx.turns[ctx.turns.length - 1].engine, 'fable');
  await team.askMember(ctx.root, { member: 'writer', cardId: card.id, text: 'And you?', env: ctx.env, deps: ctx.deps });
  assert.equal(ctx.turns[ctx.turns.length - 1].engine, 'codex');
  // One member, by a person only.
  assert.throws(() => team.setMemberEngine(ctx.root, 'scout', 'fable', { env: ctx.agentEnv }), (e) => e.status === 403);
  team.setMemberEngine(ctx.root, 'scout', 'fable', options);
  assert.deepEqual([team.memberEngine(ctx.root, 'scout', options).id, team.memberEngine(ctx.root, 'scout', options).source], ['fable', 'feed-member']);
  assert.equal(team.memberEngine(ctx.root, 'writer', options).id, 'codex');
  team.setMemberEngine(ctx.root, 'scout', 'none', options);
  assert.equal(team.memberEngine(ctx.root, 'scout', options).id, 'codex');
  // The feed default.
  team.setDefaultEngine(ctx.root, 'fable', options);
  assert.deepEqual([team.memberEngine(ctx.root, 'writer', options).id, team.memberEngine(ctx.root, 'writer', options).source], ['fable', 'feed']);
});

// ------------------------------------------------------------ the feed asking by itself

test('by itself the feed asks once, then stays quiet until the person acts or the project changes, and never past the hour\'s cap', async (t) => {
  const { changed } = require('./helpers/feed-project');
  const ctx = project(t, ['scout', 'writer', 'closer']);
  const env = { ...ctx.env, ATRIS_FEED_MEMBER_GAP_SECONDS: '0' };
  const auto = (reason = 'scroll') => team.ping(ctx.root, { reason, env, deps: ctx.deps });
  assert.equal(auto().pinged, 3, 'the first look at the end of the feed brings the team in');
  // The end of the feed again, and the heartbeat: nothing changed, so nobody runs.
  for (const reason of ['scroll', 'heartbeat', 'scroll']) {
    const quiet = auto(reason);
    assert.equal(quiet.pinged, 0);
    assert.match(quiet.reason, /Nothing changed in the project since the team last looked/);
  }
  // The team's own writing is never a reason to ask again.
  room.say(ctx.root, { as: 'scout', text: 'The soap page loads fast now.', env: ctx.env, deps: ctx.deps });
  feed.proposeCard(ctx.root, { as: 'writer', title: 'Write the spring price note', why: 'Buyers ask', env: ctx.env });
  assert.equal(auto().pinged, 0);
  // The person acting is: a note from them, and the feed asks once more.
  room.say(ctx.root, { text: 'What should we do about returns?', env: ctx.env, deps: ctx.deps });
  assert.equal(auto().pinged, 3);
  assert.equal(auto().pinged, 0);
  // Six runs in the hour is the most the feed starts by itself, even when the project keeps changing.
  assert.equal(team.AUTO_RUNS_PER_HOUR, 6);
  changed(ctx);
  const capped = auto();
  assert.equal(capped.pinged, 0);
  assert.match(capped.reason, /brought in 6 times in the last hour without being asked, the most/);
  // A person asking is never held to it: refresh, or a member by name.
  assert.equal(team.ping(ctx.root, { reason: 'refresh', env, deps: ctx.deps }).pinged, 3);
  assert.equal(team.ping(ctx.root, { member: 'scout', reason: 'scroll', env, deps: ctx.deps }).pinged, 1);
});

test('a teammate still writing when the feed is cleared writes nothing onto the cleared feed', async (t) => {
  const ctx = project(t, ['asker', 'scout']);
  const card = ask(ctx);
  const other = room.say(ctx.root, { text: 'How do we bring buyers back?', env: ctx.env, deps: ctx.deps }).card;
  void card;
  ctx.deps.turn = async ({ onText }) => {
    // The person clears the feed while the teammate is mid-answer.
    room.clear(ctx.root, { env: ctx.env, confirmed: true });
    const text = ['IDEA', 'TITLE: Thank the first ten buyers', 'WHY: Thanked buyers come back', 'END',
      'POST', 'TEXT: Three buyers came back twice this month.', 'END',
      'REPLY 1: IDEA: Send each returning buyer a short thank you.', 'REACT 1: 👍',
      'OUTCOME 2', 'ANSWER: Yes, we can.', 'NEXT: Build the example.', 'OWNER: scout', 'END', ''].join('\n');
    onText(text);
    return { ok: true, text };
  };
  const events = [];
  await team.pingStream(ctx.root, { member: 'scout', reason: 'scroll', noRetry: true, env: ctx.env, deps: ctx.deps, onEvent: (e) => events.push(e) });
  void other;
  assert.equal(events.filter((e) => e.type === 'card_done' || e.type === 'card_changed').length, 0, 'nothing landed');
  assert.deepEqual(feed.listCards(ctx.root, { env: ctx.env, limit: 100 }).cards, [], 'the cleared feed stays empty');
  assert.equal(room.readNotes(ctx.root).length, 0);
  assert.match(droppedLines(ctx), /The feed was cleared while this was being written/);
});
