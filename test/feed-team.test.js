'use strict';

// The team behind the local feed: one default model, ON members, a fast
// answer when the person talks, one log per member, pings and events, more
// ideas on scroll, and `feed start` for a new folder. Every engine and run
// here is a stand-in.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const tasks = require('../lib/task-db');
const feed = require('../lib/feed-core');
const team = require('../lib/feed-team');
const { setMemberAwake } = require('../lib/member-switches');
const { project } = require('./helpers/feed-project');

function propose(ctx, fields = {}) {
  return feed.proposeCard(ctx.root, { as: 'scout', title: 'Call the ten oldest leads', why: 'Old leads answer more often', env: ctx.env, ...fields });
}

function logText(ctx, member) {
  const dir = path.join(ctx.root, 'atris', 'team', member, 'logs');
  if (!fs.existsSync(dir)) return '';
  return fs.readdirSync(dir).map((name) => fs.readFileSync(path.join(dir, name), 'utf8')).join('\n');
}

// ------------------------------------------------------- one default model

test('engines: what can run here, local and cloud, each with a reason when it cannot', () => {
  const list = team.listEngines({ isInstalled: (bin) => bin === 'codex', authToken: () => '' });
  const codex = list.find((e) => e.id === 'codex');
  assert.equal(codex.kind, 'local');
  assert.equal(codex.available, true);
  const claude = list.find((e) => e.id === 'claude');
  assert.equal(claude.available, false);
  assert.match(claude.reason, /not installed/);
  const cloud = list.find((e) => e.id === 'atris-fast');
  assert.equal(cloud.kind, 'cloud');
  assert.equal(cloud.available, false, 'the Atris models need a sign-in');
  assert.equal(cloud.reason, 'This computer is signed out of Atris. Sign it in again.');
  assert.equal(team.listEngines({ isInstalled: () => false, authToken: () => 'token' }).find((e) => e.id === 'atris-fast').available, true);
  assert.equal(list.find((e) => e.id === 'atris-agent-1').available, false);
  for (const engine of list) for (const key of ['id', 'name', 'kind', 'available']) assert.ok(key in engine, key);
});

test('settings: one default model, stored in the project atris config; an unavailable pick is refused, never saved', (t) => {
  const ctx = project(t, ['scout'], { engine: null });
  assert.throws(() => team.setDefaultEngine(ctx.root, 'grok', { env: ctx.env }), (e) => e.status === 409 && /cannot run on this computer/.test(e.message));
  assert.equal(team.readFeedConfig(ctx.root).default_engine, undefined, 'nothing saved');
  assert.throws(() => team.setDefaultEngine(ctx.root, 'nonsense', { env: ctx.env }), (e) => e.status === 400);
  assert.throws(() => team.setDefaultEngine(ctx.root, 'codex', { env: ctx.agentEnv }), (e) => e.status === 403);
  const out = team.setDefaultEngine(ctx.root, 'codex', { env: ctx.env });
  assert.equal(out.default_engine, 'codex');
  assert.equal(JSON.parse(fs.readFileSync(path.join(ctx.root, 'atris', '.config'), 'utf8')).feed.default_engine, 'codex');
});

test('settings: a member\'s own roster line, else the feed default, else the house pick', (t) => {
  const ctx = project(t, ['scout', 'writer'], { engine: null });
  const workspace = team.memberEngine(ctx.root, 'writer');
  assert.equal(workspace.source, 'house');
  fs.writeFileSync(path.join(ctx.root, 'atris', '.config'), JSON.stringify({ feed: { default_engine: 'codex' } }));
  fs.writeFileSync(path.join(ctx.root, 'atris', 'ROSTER.md'), '# roster\n\n## team\n- scout: haiku\n');
  assert.deepEqual([team.memberEngine(ctx.root, 'scout').id, team.memberEngine(ctx.root, 'scout').source], ['haiku', 'member']);
  assert.deepEqual([team.memberEngine(ctx.root, 'writer').id, team.memberEngine(ctx.root, 'writer').source], ['codex', 'feed']);
});

// ------------------------------------------------------------ ON and OFF

test('members: on or off from the existing member switch; a member nobody switched on is off', (t) => {
  const ctx = project(t, ['scout', 'writer', 'boss'], { on: false });
  fs.writeFileSync(path.join(ctx.root, 'atris', 'team', 'boss', 'MEMBER.md'), '---\nname: boss\nrole: Owner\ntype: human\n---\n');
  let list = team.listMembers(ctx.root, { env: ctx.env });
  assert.equal(list.on, 0);
  assert.deepEqual(Object.keys(list.members[0]).sort(), ['doing', 'engine', 'engine_available', 'engine_name', 'engine_source', 'last_active', 'name', 'on', 'role']);
  list = team.setOn(ctx.root, 'scout', true, { env: ctx.env });
  assert.equal(list.members.find((m) => m.name === 'scout').on, true);
  assert.equal(list.members.find((m) => m.name === 'scout').engine, 'codex');
  assert.equal(JSON.parse(fs.readFileSync(path.join(ctx.root, '.atris', 'state', 'member-switches.json'), 'utf8')).members.scout.awake, true);
  assert.throws(() => team.setOn(ctx.root, 'boss', true, { env: ctx.env }), (e) => e.status === 409, 'a person is never run as a member');
  assert.throws(() => team.setOn(ctx.root, 'scout', false, { env: ctx.agentEnv }), (e) => e.status === 403);
  setMemberAwake('scout', false, ctx.root); // `atris sleep scout` turns it off for the feed too
  assert.equal(team.isOn(ctx.root, 'scout'), false);
});

test('members: approving an idea from an OFF member says so and starts nothing', (t) => {
  const ctx = project(t);
  const { card } = propose(ctx);
  setMemberAwake('scout', false, ctx.root);
  assert.throws(() => feed.decide(ctx.root, card.id, 'approve', { env: ctx.env, deps: ctx.deps }),
    (e) => e.status === 409 && /scout is off/.test(e.message) && /atris feed member on scout/.test(e.message));
  assert.equal(ctx.spawned.length, 0);
  assert.equal(feed.listCards(ctx.root, { env: ctx.env }).cards[0].needs_decision, true, 'the idea still waits');
  assert.equal(feed.decide(ctx.root, card.id, 'dismiss', { env: ctx.env, deps: ctx.deps }).outcome.reason, 'dismissed', 'a no needs nobody on');
});

test('members: an approval whose model cannot run here is refused plainly', (t) => {
  const ctx = project(t, ['scout'], { engine: 'grok' });
  const { card } = propose(ctx);
  assert.throws(() => feed.decide(ctx.root, card.id, 'approve', { env: ctx.env, deps: ctx.deps }), (e) => e.status === 409 && /Grok/.test(e.message));
  assert.equal(ctx.spawned.length, 0);
});

// ------------------------------------------------------------ fast talk

test('talk: the member answers at once in one turn, streamed, outside the work queue', async (t) => {
  const ctx = project(t);
  feed.setTheme(ctx.root, 'Get ten paying customers by December', { env: ctx.env });
  const { card } = propose(ctx);
  const events = [];
  const out = await feed.talk(ctx.root, card.id, 'Can we start with the five oldest?', { env: ctx.env, deps: ctx.deps, onEvent: (e) => events.push(e) });
  assert.equal(out.reply_pending, false);
  assert.equal(out.reply.from.id, 'agent:scout');
  assert.equal(out.reply.text, 'Yes, I can start with the five oldest leads.');
  assert.equal(ctx.spawned.length, 0, 'no member run, no queue');
  assert.equal(events[0].type, 'saved');
  assert.ok(events.filter((e) => e.type === 'chunk').length > 1, 'streamed in pieces');
  assert.equal(events.filter((e) => e.type === 'chunk').map((e) => e.text).join(''), 'Yes, I can start with the five oldest leads.');
  assert.deepEqual(events.slice(-2).map((e) => e.type), ['reply', 'done']);
  const prompt = ctx.turns[0].prompt;
  assert.match(prompt, /You are scout/);
  assert.match(prompt, /role: scout of the team/, 'its member file');
  assert.match(prompt, /Get ten paying customers by December/, 'the goal');
  assert.match(prompt, /Call the ten oldest leads/, 'the card');
  assert.match(prompt, /Owner: Can we start with the five oldest\?/, 'the thread');
  assert.equal(ctx.turns[0].engine, 'codex', 'the model in effect for the member');
  const thread = feed.listMessages(ctx.root, card.id, { env: ctx.env });
  assert.equal(thread.messages.length, 2);
  assert.equal(thread.reply_pending, false);
  await assert.rejects(feed.talk(ctx.root, card.id, 'hello', { env: ctx.agentEnv, deps: ctx.deps }), (e) => e.status === 403);
});

test('talk: a change the person asks for comes back as a revision, through the revise checks', async (t) => {
  const ctx = project(t);
  const { card } = propose(ctx);
  ctx.deps.answer = () => 'Good call, five is easier.\nREVISE {"title": "Call the five oldest leads", "why": "Five calls fit one morning"}';
  const events = [];
  const out = await feed.talk(ctx.root, card.id, 'Make it five, not ten', { env: ctx.env, deps: ctx.deps, onEvent: (e) => events.push(e) });
  assert.equal(out.reply.text, 'Good call, five is easier.');
  assert.equal(out.card.title, 'Call the five oldest leads');
  assert.equal(out.card.why, 'Five calls fit one morning');
  assert.ok(!events.some((e) => e.type === 'chunk' && /REVISE/.test(e.text)), 'the revision line is never shown as words');
  assert.ok(events.some((e) => e.type === 'revision'));
  ctx.deps.answer = () => 'Sure.\nREVISE {"title": "Merge the branch into the repo"}';
  const refused = await feed.talk(ctx.root, card.id, 'Rename it', { env: ctx.env, deps: ctx.deps });
  assert.equal(refused.card, null);
  assert.match(refused.revision_error, /plain words/);
});

test('talk: a jargon answer is kept as detail; an OFF member or a missing model is said plainly', async (t) => {
  const ctx = project(t);
  const { card } = propose(ctx);
  ctx.deps.answer = () => 'I merged the branch into the repo.';
  const jargon = await feed.talk(ctx.root, card.id, 'Done?', { env: ctx.env, deps: ctx.deps });
  assert.match(jargon.reply.text, /technical detail/);
  assert.equal(jargon.reply.detail, 'I merged the branch into the repo.');
  setMemberAwake('scout', false, ctx.root);
  const off = await feed.talk(ctx.root, card.id, 'Still there?', { env: ctx.env, deps: ctx.deps });
  assert.match(off.reply_skipped, /scout is off/);
  assert.equal(off.reply_pending, false);
  setMemberAwake('scout', true, ctx.root);
  fs.writeFileSync(path.join(ctx.root, 'atris', '.config'), JSON.stringify({ feed: { default_engine: 'grok' } }));
  const missing = await feed.talk(ctx.root, card.id, 'Hello?', { env: ctx.env, deps: ctx.deps });
  assert.match(missing.reply_skipped, /Grok/);
});

test('talk: the turn command is tool-free and streams on Claude; read-only on Codex', () => {
  const claude = team.turnInvocation({ id: 'claude' }, 'hi');
  assert.equal(claude.args[claude.args.indexOf('--tools') + 1], '');
  assert.ok(claude.args.includes('stream-json') && claude.args.includes('--include-partial-messages'));
  const codex = team.turnInvocation({ id: 'codex' }, 'hi');
  assert.equal(codex.args[codex.args.indexOf('--sandbox') + 1], 'read-only');
  assert.ok(codex.args.includes('--json'));
  const shown = [];
  const filter = team.revisionFilter((piece) => shown.push(piece));
  for (const piece of ['Fine by me.', '\nRE', 'VISE {"title": "x"}']) filter.push(piece);
  filter.end();
  assert.equal(shown.join(''), 'Fine by me.\n');
});

test('talk: a card conversation stays on the card: nothing reaches the board or the feed events', async (t) => {
  const ctx = project(t);
  const { card } = propose(ctx);
  const posted = [];
  await feed.talk(ctx.root, card.id, 'Five is enough', { env: ctx.env, deps: { ...ctx.deps, board: (e) => posted.push(e) } });
  assert.deepEqual(posted, []);
  assert.deepEqual(team.readEvents(ctx.root), []);
});

test('talk: a cloud reply runs on the person\'s own sign-in, never another key', async (t) => {
  const ctx = project(t, ['scout'], { engine: 'atris-fast' });
  const { card } = propose(ctx);
  const sc = require('../lib/sentinel-cloud');
  const real = sc.runAtrisTurn;
  const seen = [];
  sc.runAtrisTurn = async (args) => { seen.push(args); args.onText('Yes.'); return { ok: true, stdout: 'Yes.' }; };
  t.after(() => { sc.runAtrisTurn = real; });
  const out = await feed.talk(ctx.root, card.id, 'Five?', { env: { ...ctx.env, ATRIS_TOKEN: 'the-persons-own-token' }, deps: {} });
  assert.equal(out.reply.text, 'Yes.');
  assert.equal(seen[0].token, 'the-persons-own-token');
  assert.equal(seen[0].model, 'atris:fast');
});

test('cli: feed talk --help names --stream, so the app streams replies instead of waiting', (t) => {
  const ctx = project(t);
  const run = require('node:child_process').spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'atris.js'), 'feed', 'talk', '--help'], { cwd: ctx.root, env: ctx.env, encoding: 'utf8' });
  assert.match(run.stdout, /--stream/);
  const streamed = require('node:child_process').spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'atris.js'), 'feed', 'talk', '--stream', '--json', '--', 'task:nope:1:proposal', 'hi'], { cwd: ctx.root, env: ctx.env, encoding: 'utf8' });
  const last = JSON.parse(streamed.stdout.trim().split('\n').pop());
  assert.equal(last.type, 'error', 'a streamed talk that fails ends with one error line, so the screen stops waiting');
});

// ------------------------------------------------------- one log per member

test('log: pings, talk, approvals and results land in the member\'s own log', async (t) => {
  const ctx = project(t);
  const { card } = propose(ctx);
  await feed.talk(ctx.root, card.id, 'Five, please', { env: ctx.env, deps: ctx.deps });
  feed.decide(ctx.root, card.id, 'approve', { env: ctx.env, deps: ctx.deps });
  team.ping(ctx.root, { member: 'writer', reason: 'scroll', env: ctx.env, deps: ctx.deps });
  const text = logText(ctx, 'scout');
  for (const line of ['The owner wrote on a card', 'Answered the owner', 'The owner approved a card']) assert.match(text, new RegExp(line));
  assert.match(logText(ctx, 'writer'), /Asked for ideas \(scroll\)/);
  // The next turn starts from that log.
  const { card: second } = propose(ctx, { title: 'Write the spring price note' });
  await feed.talk(ctx.root, second.id, 'Shorter?', { env: ctx.env, deps: ctx.deps });
  assert.match(ctx.turns[1].prompt, /The owner approved a card/);
});

// ----------------------------------------------------------------- pings

// ------------------------------------------------------------------ emit

test('emit: ideas go through the propose rules; progress and results only from the member doing the work', (t) => {
  const ctx = project(t);
  feed.setTheme(ctx.root, 'Get ten paying customers by December', { env: ctx.env });
  assert.throws(() => team.emit(ctx.root, { as: 'scout', type: 'idea', title: 'Call five leads', env: ctx.env }), (e) => e.field === 'why');
  const idea = team.emit(ctx.root, { as: 'scout', type: 'idea', title: 'Call five leads', why: 'They answer', env: ctx.env });
  assert.equal(idea.event.type, 'idea');
  setMemberAwake('writer', false, ctx.root);
  assert.throws(() => team.emit(ctx.root, { as: 'writer', type: 'idea', title: 'Write a note', why: 'x', env: ctx.env }), (e) => /writer is off/.test(e.message));
  feed.decide(ctx.root, idea.card.id, 'approve', { env: ctx.env, deps: ctx.deps });
  assert.throws(() => team.emit(ctx.root, { as: 'closer', type: 'progress', card: idea.card.id, text: 'Called two', env: ctx.env }), (e) => e.status === 403);
  assert.throws(() => team.emit(ctx.root, { as: 'scout', type: 'progress', card: idea.card.id, text: 'Pushed the branch', env: ctx.env }), (e) => e.remove.includes('branch'));
  team.emit(ctx.root, { as: 'scout', type: 'progress', card: idea.card.id, text: 'Called two of the five', env: ctx.env });
  const working = feed.listCards(ctx.root, { filter: 'working', env: ctx.env }).cards.find((c) => c.id === idea.card.id);
  assert.equal(working.progress.text, 'Called two of the five');
  assert.deepEqual(working.story, ['Called two of the five']);
  assert.throws(() => team.emit(ctx.root, { as: 'scout', type: 'result', card: idea.card.id, env: ctx.env }), (e) => /proof/.test(e.message));
  const done = team.emit(ctx.root, { as: 'scout', type: 'result', card: idea.card.id, proof: 'Called all five; three said yes.', text: 'Three of five said yes', env: ctx.env });
  assert.equal(tasks.getTask(ctx.db, idea.card.source.id).status, 'review', 'finished work waits for the person to accept it');
  const accept = feed.listCards(ctx.root, { env: ctx.env }).cards.find((c) => c.source.id === idea.card.source.id && /:accept$/.test(c.id));
  assert.ok(accept && accept.needs_decision);
  assert.equal(accept.proof.status, 'unverified', 'no receipt, so not verified');
  assert.deepEqual(team.readEvents(ctx.root).map((e) => e.type), ['idea', 'decision', 'progress', 'result']);
  assert.equal(done.event.member, 'scout');
});

test('emit: the same stream reads from atris channel feed when there is no hosted board', async (t) => {
  const ctx = project(t);
  team.emit(ctx.root, { as: 'scout', type: 'idea', title: 'Call five leads', why: 'They answer', env: ctx.env });
  const { channelCommand } = require('../commands/channel');
  const lines = [];
  const before = process.cwd();
  process.chdir(ctx.root);
  try {
    const code = await channelCommand(['feed'], { log: (l) => lines.push(l), err: (l) => lines.push(`ERR ${l}`), loginToken: async () => '' });
    assert.equal(code, 0);
  } finally {
    process.chdir(before);
  }
  assert.ok(lines.some((line) => /scout/.test(line) && /idea: Call five leads/.test(line)), lines.join('\n'));
});

// ------------------------------------------------------------ more on scroll

test('more: the person asks up to three ON members for more, with the person\'s taste in their brief', async (t) => {
  const ctx = project(t, ['scout', 'writer', 'closer', 'extra']);
  const yes = propose(ctx, { title: 'Call the warm leads today' }).card;
  feed.decide(ctx.root, yes.id, 'approve', { note: 'more like this', env: ctx.env, deps: ctx.deps });
  const no = propose(ctx, { as: 'writer', title: 'Write a long blog post' }).card;
  feed.decide(ctx.root, no.id, 'dismiss', { note: 'nobody reads them', env: ctx.env, deps: ctx.deps });
  const skipped = propose(ctx, { as: 'closer', title: 'Ask three owners for a quote' }).card;
  feed.passCards(ctx.root, [skipped.id], { env: ctx.env, now: Date.now() + 11000 });
  await feed.talk(ctx.root, skipped.id, 'Which owners exactly?', { env: ctx.env, deps: ctx.deps });
  ctx.spawned.length = 0;
  const out = feed.requestMoreIdeas(ctx.root, { env: ctx.env, deps: ctx.deps });
  assert.ok(out.requested >= 1 && out.requested <= 3);
  assert.ok(ctx.thinkers.length === 1 && ctx.thinkers[0].names.length <= 3 && ctx.thinkers[0].reason === 'more', 'a person asking for more, never held to what the feed may start by itself');
  assert.equal(feed.readRuns(ctx.root).filter((e) => e.kind === 'ping').length, 0, 'thinking never uses the work queue');
  const brief = team.pingBrief(ctx.root, 'extra', 'scroll');
  assert.match(brief, /said yes to these[\s\S]*Call the warm leads today \(owner said: more like this\)/);
  assert.match(brief, /said no to these[\s\S]*Write a long blog post \(owner said: nobody reads them\)/);
  assert.match(brief, /scrolling past these[\s\S]*Ask three owners for a quote/);
  assert.match(brief, /What the owner said on cards[\s\S]*Which owners exactly\?/);
  assert.throws(() => feed.requestMoreIdeas(ctx.root, { env: ctx.agentEnv, deps: ctx.deps }), (e) => e.status === 403);
});

// --------------------------------------------------------- start a folder

test('refresh asks every awake member while keeping at most three turns running', async (t) => {
  const ctx = project(t, ['scout', 'writer', 'closer', 'builder', 'editor']);
  let running = 0;
  let peak = 0;
  const names = [];
  const events = [];
  const deps = { ...ctx.deps, turn: async ({ prompt, onText }) => {
    running++;
    peak = Math.max(peak, running);
    names.push(prompt.match(/^You are ([^,]+),/)?.[1]);
    await new Promise((resolve) => setTimeout(resolve, 5));
    onText('');
    running--;
    return { ok: true, text: '' };
  } };
  const result = await team.pingStream(ctx.root, { reason: 'event', env: ctx.env, deps, onEvent: (event) => events.push(event) });
  assert.equal(result.pinged, 5);
  assert.equal(new Set(names).size, 5);
  assert.ok(peak <= 3);
  assert.equal(events.filter((event) => event.type === 'member_started').length, 5);
  assert.match(team.ideaPrompt(ctx.root, 'scout', 'refresh'), /generated setup files[\s\S]*ask at most one direct question/);
});

test('start: an existing atris folder without a team gets a starter team', async (t) => {
  const ctx = project(t, []);
  const existing = fs.readFileSync(path.join(ctx.root, 'atris', 'atris.md'), 'utf8');
  const runCli = (root, args) => {
    assert.deepEqual(args.slice(0, 2), ['member', 'create']);
    const name = args[2];
    fs.mkdirSync(path.join(root, 'atris', 'team', name), { recursive: true });
    fs.writeFileSync(path.join(root, 'atris', 'team', name, 'MEMBER.md'), `---\nname: ${name}\nrole: ${name}\n---\n`);
    return { stdout: '', stderr: '' };
  };
  const out = await team.start(ctx.root, { env: ctx.env, deps: { ...ctx.deps, runCli } });
  assert.equal(out.started, true);
  assert.ok(out.created.includes('scout'));
  assert.ok(out.members.filter((m) => out.created.includes(m.name)).every((m) => m.on));
  assert.equal(team.readOnlyUntilApproved(ctx.root), true);
  assert.equal(fs.readFileSync(path.join(ctx.root, 'atris', 'atris.md'), 'utf8'), existing);
  assert.ok(out.ping.pinged >= 1);
  const again = await team.start(ctx.root, { env: ctx.env, deps: { ...ctx.deps, runCli } });
  assert.equal(again.started, false);
  assert.deepEqual(again.created, []);
});

test('start: a folder of projects gets atris, a starter team turned on, and a first read-only ping; idempotent', async (t) => {
  const ctx = project(t, []);
  const folder = path.join(ctx.dir, 'strangers');
  fs.mkdirSync(path.join(folder, 'shop'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'shop', 'package.json'), '{"name":"shop"}');
  fs.writeFileSync(path.join(folder, 'shop', 'index.js'), 'console.log("shop")\n');
  fs.mkdirSync(path.join(folder, 'notes'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'notes', 'README.md'), '# Notes\n');
  fs.writeFileSync(path.join(folder, 'atris-before.txt'), 'x');
  const env = { ...ctx.env, HOME: ctx.dir };
  const out = await team.start(folder, { env, deps: ctx.deps, engine: 'codex' });
  assert.equal(out.started, true);
  assert.ok(fs.existsSync(path.join(folder, 'atris')));
  assert.deepEqual(out.created.sort(), ['builder', 'scout']);
  assert.ok(out.members.filter((m) => ['builder', 'scout'].includes(m.name)).every((m) => m.on));
  assert.equal(team.readOnlyUntilApproved(folder), true);
  assert.ok(fs.existsSync(path.join(folder, '.git')), 'a git folder, so member runs can work and every change can be undone');
  const log = require('node:child_process').spawnSync('git', ['log', '--oneline'], { cwd: folder, encoding: 'utf8' }).stdout.trim().split('\n');
  assert.equal(log.length, 1, 'one starting point');
  assert.ok(out.ping.pinged >= 1, out.ping.reason);
  assert.equal(ctx.spawned.length, 0, 'nothing that can write starts before an approval');
  assert.deepEqual(ctx.thinkers[0].names.sort(), ['builder', 'scout'], 'the first wake is thinking only');
  assert.equal(fs.readFileSync(path.join(folder, 'shop', 'index.js'), 'utf8'), 'console.log("shop")\n', 'nothing changed');
  const again = await team.start(folder, { env, deps: { ...ctx.deps, isAlive: () => false } });
  assert.equal(again.started, false);
  assert.deepEqual(again.created, []);
  assert.match(again.steps[0], /already here, left as it is/);
  await assert.rejects(team.start(folder, { env: ctx.agentEnv, deps: ctx.deps }), (e) => e.status === 403);
});
