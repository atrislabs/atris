'use strict';

// spends: nothing (scratch folders, stand-in member creation; no model, no network)
//
// atris feed setup: the starter team joins one card at a time, the project is
// read by plain rules into a few real findings, then at most three questions
// are asked one at a time. Answers land in the project's lessons; skips save
// nothing; a second run adds nothing.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const feed = require('../lib/feed-core');
const room = require('../lib/feed-room');
const setupLib = require('../lib/feed-setup');
const { buildRepoMap } = require('../lib/try-repo');
const { plumbingWords } = require('../lib/feed-plain-words');
const decisionFeed = require('../commands/decision-feed');
const { project } = require('./helpers/feed-project');

const BIN = path.join(__dirname, '..', 'bin', 'atris.js');

// A small real-looking shop: express app, readme, two code folders, one test.
function writeShop(dir) {
  const files = {
    'package.json': JSON.stringify({ name: 'shop', scripts: { test: 'node --test', start: 'node server/index.js' }, dependencies: { express: '^4' } }),
    'README.md': '# Sock Shop\n\n[![build](https://x/badge.svg)](https://x)\n\nA tiny store that sells warm socks to people in cold towns. It runs on one small server.\n',
    'server/index.js': 'function main() {}\nmodule.exports = { main };\n',
    'server/routes.js': 'function routes() {}\n',
    'web/app.js': 'function app() {}\n',
    'test/shop.test.js': 'require("node:test");\n',
  };
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
}

// Stand-ins for `atris init` and `atris member create`, so nothing real spawns.
function fakeCli(calls = []) {
  return (cwd, args) => {
    calls.push(args.slice(0, 3).join(' '));
    if (args[0] === 'init') {
      fs.mkdirSync(path.join(cwd, 'atris', 'team'), { recursive: true });
      fs.writeFileSync(path.join(cwd, 'atris', 'atris.md'), '# atris\n');
      fs.writeFileSync(path.join(cwd, 'CLAUDE.md'), '# written by atris\n');
    } else if (args[0] === 'member' && args[1] === 'create') {
      const name = args[2];
      fs.mkdirSync(path.join(cwd, 'atris', 'team', name), { recursive: true });
      fs.writeFileSync(path.join(cwd, 'atris', 'team', name, 'MEMBER.md'), `---\nname: ${name}\nrole: ${name}\n---\n`);
    }
    return { ok: true, status: 0, stdout: '', stderr: '' };
  };
}

function freshFolder(t, ctx, name = 'fresh') {
  const folder = path.join(ctx.dir, name);
  fs.mkdirSync(folder, { recursive: true });
  const calls = [];
  const deps = { ...ctx.deps, runCli: fakeCli(calls), git: () => ({ status: 0 }) };
  return { folder, deps, calls };
}

async function runSetup(folder, ctx, deps) {
  const events = [];
  const out = await setupLib.setup(folder, { env: ctx.env, deps, onStep: (e) => events.push(e) });
  return { out, events };
}

function notes(root) {
  return room.readNotes(root);
}

function cardsOf(root, env) {
  return feed.listCards(root, { env, limit: 100 }).cards;
}

function lessons(root) {
  try { return fs.readFileSync(path.join(root, 'atris', 'lessons.md'), 'utf8'); } catch { return ''; }
}

test('setup: a new project gets its team one card at a time, then findings, then one question', async (t) => {
  const ctx = project(t, []);
  const { folder, deps, calls } = freshFolder(t, ctx);
  writeShop(folder);
  const { out, events } = await runSetup(folder, ctx, deps);
  const kinds = events.map((e) => e.kind);
  assert.deepEqual(kinds, ['setup', 'setup', 'join', 'join', 'finding', 'finding', 'finding', 'finding', 'ask']);
  assert.deepEqual(events.filter((e) => e.kind === 'join').map((e) => e.member), ['scout', 'builder']);
  assert.equal(events[2].text, "I'm your scout. I look things up and read the project before anyone builds.");
  assert.equal(events[3].text, "I'm your builder. I make small fixes in the code, only after you say yes.");
  assert.deepEqual(calls, ['init --yes --no-commit', 'member create scout', 'member create builder']);
  // Each card is in the feed, by the member that said it, in plain words.
  const byId = new Map(cardsOf(out.folder, ctx.env).map((c) => [c.id, c]));
  for (const e of events.filter((x) => x.card_id)) {
    assert.ok(byId.has(e.card_id), `card ${e.card_id} is in the feed`);
    assert.equal(byId.get(e.card_id).title, e.text);
    assert.deepEqual(plumbingWords(e.text), [], e.text);
  }
  assert.equal(byId.get(events[2].card_id).author.name, 'scout');
  assert.equal(byId.get(events[8].card_id).kind, 'ask');
  assert.equal(out.new_project, true);
  assert.equal(out.model_calls, 0);
  assert.equal(ctx.turns.length, 0, 'no model turn');
  assert.equal(ctx.thinkers.length, 0, 'no first ping: nothing thinks');
  assert.equal(ctx.spawned.length, 0);
  assert.deepEqual(out.asks, { total: 2, answered: 0, skipped: 0, left: 2, waiting: { card_id: events[8].card_id, key: 'audience', text: events[8].text } });
  assert.equal(out.read.files, 6, 'the file atris wrote is not counted');
});

test('setup: findings match what is in the project, and the readme answers what it is for', async (t) => {
  const ctx = project(t, ['scout']);
  writeShop(ctx.root);
  const { events, out } = await runSetup(ctx.root, ctx, ctx.deps);
  assert.deepEqual(events.filter((e) => e.kind === 'finding').map((e) => e.text), [
    'This looks like a Node project built with Express. I counted 6 files, mostly JavaScript.',
    'I read your readme. It calls this Sock Shop and says: A tiny store that sells warm socks to people in cold towns.',
    'The code is split into 2 main parts: server and web. The biggest is server, with 2 files of code.',
    'I found 1 test file and a start script, so I know how to run it and check changes.',
  ]);
  assert.equal(out.read.findings, 4);
  // The readme said what it is for, so that is not asked.
  const state = JSON.parse(fs.readFileSync(path.join(ctx.root, '.atris', 'state', 'feed', 'setup.json'), 'utf8'));
  assert.deepEqual(state.asks.map((a) => a.key), ['audience', 'done']);
});

test('setup: an existing project with a team on gets no join cards and starts no one', async (t) => {
  const ctx = project(t, ['scout', 'writer']);
  writeShop(ctx.root);
  const deps = { ...ctx.deps, runCli: () => assert.fail('nothing is created for a team that is on') };
  const { events, out } = await runSetup(ctx.root, ctx, deps);
  assert.equal(events.filter((e) => e.kind === 'join').length, 0);
  assert.equal(events[0].kind, 'finding');
  assert.equal(out.new_project, false);
  assert.deepEqual(out.joined, []);
  assert.equal(out.speaker, 'scout');
});

test('setup: an atris folder whose members were never switched on gets the starter team', async (t) => {
  const ctx = project(t, ['executor', 'navigator'], { on: false });
  const calls = [];
  const { events } = await runSetup(ctx.root, ctx, { ...ctx.deps, runCli: fakeCli(calls) });
  assert.deepEqual(events.filter((e) => e.kind === 'join').map((e) => e.member), ['scout']);
  assert.deepEqual(calls, ['member create scout']);
});

test('setup: nothing found means no finding card; at most three questions, asked one at a time', async (t) => {
  const ctx = project(t, ['scout']);
  const { events, out } = await runSetup(ctx.root, ctx, ctx.deps);
  assert.equal(events.filter((e) => e.kind === 'finding').length, 0);
  assert.deepEqual(events.map((e) => e.kind), ['ask']);
  assert.equal(out.read.files, 0);
  assert.equal(out.asks.total, 3);
  assert.equal(out.asks.left, 3);
  const asks = cardsOf(ctx.root, ctx.env).filter((c) => c.kind === 'ask');
  assert.equal(asks.length, 1, 'one question at a time');
  assert.equal(asks[0].title, 'What is this project for, in one sentence?');
});

test('setup: a project goal already set is not asked again', async (t) => {
  const ctx = project(t, ['scout']);
  feed.setTheme(ctx.root, 'Get the first ten paying customers', { env: ctx.env });
  const { out } = await runSetup(ctx.root, ctx, ctx.deps);
  assert.equal(out.asks.total, 1);
  assert.equal(out.asks.waiting.key, 'audience');
});

test('setup: a reply on a setup question is saved as the owner\'s words and the next question appears', async (t) => {
  const ctx = project(t, ['scout']);
  const { out } = await runSetup(ctx.root, ctx, ctx.deps);
  const first = out.asks.waiting.card_id;
  const answered = room.reply(ctx.root, first, 'Small bakery owners who run their own shop', { env: ctx.env, deps: ctx.deps });
  assert.equal(answered.setup.answered, 'purpose');
  assert.match(answered.setup.lesson.id, /^fn-[a-f0-9]{8}$/);
  assert.match(lessons(ctx.root), /What this project is for, in the owner's words: Small bakery owners who run their own shop \(from "setup question: What is this project for, in one sentence\?"/);
  const team = require('../lib/feed-digest').listNotes(ctx.root).filter((n) => n.scope === 'team');
  assert.equal(team.length, 1);
  assert.equal(answered.setup.next.key, 'audience');
  const asks = cardsOf(ctx.root, ctx.env).filter((c) => c.kind === 'ask').map((c) => c.title);
  assert.deepEqual(asks.sort(), ['What is this project for, in one sentence?', 'Who is this for? A few words is plenty, like the kind of person or business that uses it.'].sort());
  // A second reply on the same card is a comment only: nothing more is saved.
  const again = room.reply(ctx.root, first, 'Also cafes', { env: ctx.env, deps: ctx.deps });
  assert.equal(again.setup, undefined);
  assert.equal(require('../lib/feed-digest').listNotes(ctx.root).length, 1);
  // A member's reply on a setup question is not the owner's answer.
  const member = room.reply(ctx.root, answered.setup.next.card_id, 'I think it is for bakers', { as: 'scout', env: ctx.env, deps: ctx.deps });
  assert.equal(member.setup, undefined);
});

test('setup: skip saves nothing and asks the next question; the last skip leaves nothing waiting', async (t) => {
  const ctx = project(t, ['scout']);
  const { out } = await runSetup(ctx.root, ctx, ctx.deps);
  const before = lessons(ctx.root);
  const one = setupLib.skip(ctx.root, out.asks.waiting.card_id, { env: ctx.env, deps: ctx.deps });
  assert.equal(one.skipped, 'purpose');
  assert.equal(one.next.key, 'audience');
  assert.equal(lessons(ctx.root), before);
  setupLib.skip(ctx.root, null, { env: ctx.env, deps: ctx.deps });
  const last = setupLib.skip(ctx.root, null, { env: ctx.env, deps: ctx.deps });
  assert.equal(last.next, null);
  assert.deepEqual({ ...last.asks, waiting: last.asks.waiting }, { total: 3, answered: 0, skipped: 3, left: 0, waiting: null });
  assert.throws(() => setupLib.skip(ctx.root, null, { env: ctx.env }), (e) => e.status === 404);
  assert.throws(() => setupLib.skip(ctx.root, null, { env: ctx.agentEnv }), (e) => e.status === 403);
  assert.equal(lessons(ctx.root), before);
});

test('setup: a second run adds no cards, makes no members and re-asks nothing answered or skipped', async (t) => {
  const ctx = project(t, []);
  const { folder, deps, calls } = freshFolder(t, ctx);
  writeShop(folder);
  const first = await runSetup(folder, ctx, deps);
  const root = first.out.folder;
  const count = notes(root).length;
  const again = await runSetup(folder, ctx, deps);
  assert.deepEqual(again.events, []);
  assert.deepEqual(again.out.cards, []);
  assert.equal(notes(root).length, count);
  assert.equal(calls.filter((c) => c.startsWith('member create')).length, 2);
  // Answer one, skip the other, run again: nothing is asked again.
  room.reply(root, first.out.asks.waiting.card_id, 'People who knit', { env: ctx.env, deps: ctx.deps });
  setupLib.skip(root, null, { env: ctx.env, deps: ctx.deps });
  const third = await runSetup(folder, ctx, deps);
  assert.deepEqual(third.events, []);
  assert.equal(notes(root).length, count + 1, 'only the one next question was added, by the answer');
  assert.equal(third.out.asks.waiting, null);
  assert.equal(third.out.asks.answered, 1);
  assert.equal(third.out.asks.skipped, 1);
});

test('setup: a folder with only a readme, and one that is not under git, finish with honest cards', async (t) => {
  const ctx = project(t, []);
  const { folder, deps } = freshFolder(t, ctx, 'notes');
  fs.writeFileSync(path.join(folder, 'README.md'), '# Garden plans\n\nWhere the tomatoes and beans go each spring.\n');
  const gitCalls = [];
  const { events } = await runSetup(folder, ctx, { ...deps, git: (cwd, args) => { gitCalls.push(args.includes('commit') ? 'commit' : args[0]); return { status: 0 }; } });
  assert.deepEqual(gitCalls, ['init', 'add', 'commit'], 'a folder not under git gets one starting point');
  assert.deepEqual(events.filter((e) => e.kind === 'join').map((e) => e.member), ['scout', 'editor']);
  assert.deepEqual(events.filter((e) => e.kind === 'finding').map((e) => e.text), [
    'This looks like a set of written notes and documents, with 1 file and no code yet.',
    'I read your readme. It calls this Garden plans and says: Where the tomatoes and beans go each spring.',
  ]);
  for (const e of events) assert.deepEqual(plumbingWords(e.text), [], e.text);
});

test('setup: an empty new folder gets its team and questions, and no finding', async (t) => {
  const ctx = project(t, []);
  const { folder, deps } = freshFolder(t, ctx, 'empty');
  const { events, out } = await runSetup(folder, ctx, deps);
  assert.deepEqual(events.filter((e) => e.kind === 'join').map((e) => e.member), ['scout']);
  assert.equal(events.filter((e) => e.kind === 'finding').length, 0);
  assert.equal(events[events.length - 1].kind, 'ask');
  assert.equal(out.read.files, 0);
});

test('setup: a large project is read under a cap and says so', (t) => {
  const ctx = project(t, ['scout']);
  for (let i = 0; i < 30; i += 1) fs.writeFileSync(path.join(ctx.root, `part${i}.py`), 'def go():\n  pass\n');
  const map = buildRepoMap(ctx.root, { maxFiles: 10, maxSymbolFiles: 0 });
  assert.equal(map.files, 10);
  assert.equal(map.capped, true);
  const quick = buildRepoMap(ctx.root, { maxMs: -1, maxSymbolFiles: 0 });
  assert.equal(quick.capped, true, 'a walk past its time stops');
  assert.equal(buildRepoMap(ctx.root, { maxSymbolFiles: 0 }).capped, false);
});

test('setup: refused inside an agent', async (t) => {
  const ctx = project(t, ['scout']);
  await assert.rejects(setupLib.setup(ctx.root, { env: ctx.agentEnv, deps: ctx.deps }), (e) => e.status === 403);
});

test('setup: --stream --json writes one line per step as it happens, then the summary', async (t) => {
  const ctx = project(t, ['scout']);
  writeShop(ctx.root);
  const lines = [];
  const code = await decisionFeed.run(['setup', '--stream', '--json'], { cwd: ctx.root, env: ctx.env, deps: ctx.deps, write: (text) => lines.push(text) });
  assert.equal(code, 0);
  const events = lines.join('').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(events.map((e) => e.type), ['step', 'step', 'step', 'step', 'step', 'done']);
  assert.deepEqual(events.slice(0, -1).map((e) => e.kind), ['finding', 'finding', 'finding', 'finding', 'ask']);
  for (const e of events.slice(0, -1)) {
    assert.deepEqual(Object.keys(e).sort(), ['card_id', 'kind', 'member', 'text', 'type']);
    assert.match(e.card_id, /^post:[a-f0-9]{12}$/);
  }
  const done = events[events.length - 1];
  assert.equal(done.done, true);
  assert.equal(done.model_calls, 0);
  assert.equal(done.cards.length, 5);
});

test('cli: atris feed setup --json runs from a project folder and a rerun is quiet', (t) => {
  const ctx = project(t, ['scout']);
  writeShop(ctx.root);
  const { spawnSync } = require('node:child_process');
  const env = { ...ctx.env, HOME: ctx.dir, ATRIS_FEED_BOARD: '0' };
  const first = spawnSync(process.execPath, [BIN, 'feed', 'setup', '--json'], { cwd: ctx.root, env, encoding: 'utf8' });
  assert.equal(first.status, 0, first.stderr);
  const out = JSON.parse(first.stdout);
  assert.equal(out.done, true);
  assert.equal(out.cards.length, 5);
  const again = spawnSync(process.execPath, [BIN, 'feed', 'setup', '--json'], { cwd: ctx.root, env, encoding: 'utf8' });
  assert.equal(again.status, 0, again.stderr);
  assert.deepEqual(JSON.parse(again.stdout).cards, []);
});

test('setup: the owner\'s own answer is saved to the lessons even with words a card may not use', async (t) => {
  const ctx = project(t, ['scout']);
  const { out } = await runSetup(ctx.root, ctx, ctx.deps);
  const answer = 'The repo is our shop site, the code in src/app\u0007 runs the checkout';
  const answered = room.reply(ctx.root, out.asks.waiting.card_id, answer, { env: ctx.env, deps: ctx.deps });
  assert.equal(answered.setup.lesson_error, undefined, answered.setup.lesson_error);
  assert.match(answered.setup.lesson.text, /in the owner's words: The repo is our shop site, the code in src\/app runs the checkout$/);
  assert.match(lessons(ctx.root), /The repo is our shop site, the code in src\/app runs the checkout/);
  assert.equal(answered.setup.next.key, 'audience');
});

test('setup: an answer that holds a key is refused for the lessons and said so', async (t) => {
  const ctx = project(t, ['scout']);
  const { out } = await runSetup(ctx.root, ctx, ctx.deps);
  const answered = room.reply(ctx.root, out.asks.waiting.card_id, 'use sk-ant-abcdefghijklmnopqrstuvwxyz0123', { env: ctx.env, deps: ctx.deps });
  assert.equal(answered.setup.lesson, null);
  assert.match(answered.setup.lesson_error, /password or key/);
  assert.doesNotMatch(lessons(ctx.root), /sk-ant-/);
});

// Every file under the project, path to bytes: the comments, the events log,
// the members' logs, the lessons and the setup state all live in it.
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

test('setup: an answer that holds a key is refused before anything is written; the question stays open', async (t) => {
  const ctx = project(t, ['scout']);
  const { out } = await runSetup(ctx.root, ctx, ctx.deps);
  const cardId = out.asks.waiting.card_id;
  const posted = [];
  const deps = { ...ctx.deps, board: (event) => posted.push(event) };
  const before = snapshot(ctx.root);
  const refused = room.reply(ctx.root, cardId, `the shop key is ${FAKE_KEY}`, { env: ctx.env, deps });
  assert.deepEqual(snapshot(ctx.root), before, 'no comment, event, member log, lesson or setup state was written');
  assert.deepEqual(posted, [], 'nothing went to the hosted feed');
  assert.equal(refused.reply, null);
  assert.equal(refused.card.id, cardId);
  assert.equal(refused.setup.lesson, null);
  assert.equal(refused.setup.lesson_error, 'That looks like it holds a password or key, so it was not saved.');
  assert.equal(refused.setup.asks.waiting.card_id, cardId, 'the same question still waits');
  assert.equal(refused.setup.asks.answered, 0);
  for (const file of Object.keys(before)) assert.doesNotMatch(Buffer.from(before[file], 'base64').toString('utf8'), /sk-test-/, file);
  // The next answer, in plain words, saves as usual.
  const saved = room.reply(ctx.root, cardId, 'It sells warm socks to people in cold towns.', { env: ctx.env, deps });
  assert.equal(saved.setup.answered, 'purpose');
  assert.equal(saved.setup.lesson_error, undefined);
  assert.match(lessons(ctx.root), /warm socks to people in cold towns/);
  assert.equal(saved.card.replies.length, 1);
});

test('setup: an answer with a document link or a commit is saved, comment and lesson both', async (t) => {
  const ctx = project(t, ['scout']);
  const { out } = await runSetup(ctx.root, ctx, ctx.deps);
  const answer = 'Our plan is in https://docs.google.com/document/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit and the shop launched at 523d8abeb1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6';
  const saved = room.reply(ctx.root, out.asks.waiting.card_id, answer, { env: ctx.env, deps: ctx.deps });
  assert.equal(saved.reply.text, answer);
  assert.equal(saved.setup.lesson_error, undefined, saved.setup.lesson_error);
  assert.equal(saved.setup.answered, 'purpose');
  assert.match(lessons(ctx.root), /1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/);
});

test('cli: atris feed reply with a key on a setup question answers with the reason, exit 0, and saves nothing', async (t) => {
  const ctx = project(t, ['scout']);
  const { out } = await runSetup(ctx.root, ctx, ctx.deps);
  const { spawnSync } = require('node:child_process');
  const env = { ...ctx.env, HOME: ctx.dir, ATRIS_FEED_BOARD: '0' };
  const before = snapshot(ctx.root);
  const run = spawnSync(process.execPath, [BIN, 'feed', 'reply', out.asks.waiting.card_id, `use ${FAKE_KEY}`, '--json'], { cwd: ctx.root, env, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const answer = JSON.parse(run.stdout);
  assert.match(answer.setup.lesson_error, /password or key/);
  assert.ok(answer.card, 'the card comes back for the screen');
  assert.deepEqual(snapshot(ctx.root), before);
  const text = spawnSync(process.execPath, [BIN, 'feed', 'reply', out.asks.waiting.card_id, `use ${FAKE_KEY}`], { cwd: ctx.root, env, encoding: 'utf8' });
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /password or key, so it was not saved/);
});

test('setup and the desktop\'s own start at the same moment on one new folder: one team, one card each', async (t) => {
  const ctx = project(t, []);
  const folder = path.join(ctx.dir, 'race');
  fs.mkdirSync(folder);
  writeShop(folder);
  const log = path.join(ctx.dir, 'race.log');
  fs.writeFileSync(log, '');
  const { spawn } = require('node:child_process');
  const child = path.join(__dirname, 'helpers', 'feed-setup-race-child.js');
  const env = { ...ctx.env, HOME: ctx.dir, ATRIS_FEED_BOARD: '0' };
  const side = (mode) => new Promise((resolve) => {
    const p = spawn(process.execPath, [child, mode, folder, log], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => { stdout += d; });
    p.stderr.on('data', (d) => { stderr += d; });
    p.on('close', (code) => resolve({ code, stdout, stderr }));
  });
  const [a, b] = await Promise.all([side('setup'), side('start')]);
  assert.equal(a.code, 0, a.stderr);
  assert.equal(b.code, 0, b.stderr);
  const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => l.split(' ').slice(1).join(' '));
  assert.equal(calls.filter((c) => c === 'init --yes --no-commit').length, 1, calls.join('; '));
  assert.equal(calls.filter((c) => c === 'git init').length, 1, calls.join('; '));
  assert.equal(calls.filter((c) => c === 'member create scout').length, 1, calls.join('; '));
  assert.equal(calls.filter((c) => c === 'member create builder').length, 1, calls.join('; '));
  const titles = cardsOf(folder, ctx.env).map((c) => c.title);
  assert.equal(new Set(titles).size, titles.length, `no card twice: ${titles.join(' | ')}`);
});

function writeFiles(dir, files) {
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
}

test('setup: a card names a framework only when the project depends on it, and counts only real test files', async (t) => {
  const ctx = project(t, ['scout']);
  writeFiles(ctx.root, {
    'pyproject.toml': '[project]\nname = "x"\ndescription = "A small tool, unlike Django"\ndependencies = ["requests"]\n',
    'app/main.py': 'import requests\n',
    'test/test_main.py': 'def test_x():\n  pass\n',
    'test/fixtures/one.json': '{}',
    'test/fixtures/two.json': '{}',
    'test/data.csv': 'a,b\n',
    'node_modules/z/index.js': 'x',
    '.venv/lib/x.py': 'x',
    'build/out.js': 'x',
    'vendor/lib.py': 'x',
  });
  const { events } = await runSetup(ctx.root, ctx, ctx.deps);
  const found = events.filter((e) => e.kind === 'finding').map((e) => e.text);
  assert.ok(found.every((text) => !/Django/.test(text)), found.join(' | '));
  assert.ok(found.some((text) => /^I found 1 test file\b/.test(text)), found.join(' | '));
  assert.ok(found.some((text) => /I counted 6 files/.test(text)), found.join(' | '));
  // A real dependency line is named.
  const real = project(t, ['scout']);
  writeFiles(real.root, { 'requirements.txt': 'Django==4.2\nrequests\n', 'app/views.py': 'x = 1\n' });
  const named = await runSetup(real.root, real, real.deps);
  assert.match(named.events.find((e) => e.kind === 'finding').text, /^This looks like a Python project built with Django\./);
});

test('setup: a readme that opens with a picture and badges, a key in it or in .env, a binary readme: nothing leaks', async (t) => {
  const ctx = project(t, ['scout']);
  const key = 'sk-ant-abcdefghijklmnopqrstuvwxyz0123';
  writeFiles(ctx.root, {
    'README.md': `<p align="center"><img src="logo.png"></p>\n\n[![ci](https://x/b.svg)](https://x)\n\nSet the key ${key} before you run the tool here.\n`,
    '.env': `API_KEY=${key}\n`,
    'main.py': 'print(1)\n',
  });
  fs.symlinkSync(ctx.root, path.join(ctx.root, 'loop'));
  const { events } = await runSetup(ctx.root, ctx, ctx.deps);
  for (const e of events) {
    assert.doesNotMatch(e.text, /sk-ant|API_KEY/, e.text);
    assert.deepEqual(plumbingWords(e.text), [], e.text);
  }
  const other = project(t, ['scout']);
  fs.writeFileSync(path.join(other.root, 'README.md'), Buffer.from(Array.from({ length: 3000 }, (_, i) => (i * 37 + 11) % 256)));
  const binary = await runSetup(other.root, other, other.deps);
  for (const e of binary.events) assert.doesNotMatch(e.text, /�|[\u0000-\u0008]/, e.text);
});

test('setup: killed after the team joined and before the read, a rerun finishes with nothing twice', async (t) => {
  const ctx = project(t, []);
  const folder = path.join(ctx.dir, 'killed');
  fs.mkdirSync(folder);
  writeShop(folder);
  const log = path.join(ctx.dir, 'killed.log');
  fs.writeFileSync(log, '');
  const { spawnSync } = require('node:child_process');
  const child = path.join(__dirname, 'helpers', 'feed-setup-race-child.js');
  const died = spawnSync(process.execPath, [child, 'setup-die', folder, log], { env: { ...ctx.env, HOME: ctx.dir }, encoding: 'utf8' });
  assert.equal(died.status, 9, died.stderr);
  const calls = [];
  const { out, events } = await runSetup(folder, ctx, { ...ctx.deps, runCli: fakeCli(calls), git: () => assert.fail('no second git step') });
  assert.deepEqual(calls, [], 'no one is made twice');
  assert.deepEqual(events.map((e) => e.kind), ['finding', 'finding', 'finding', 'finding', 'ask']);
  const titles = cardsOf(folder, ctx.env).map((c) => c.title);
  assert.equal(new Set(titles).size, titles.length, titles.join(' | '));
  assert.ok(out.asks.waiting);
  const again = await runSetup(folder, ctx, { ...ctx.deps, runCli: fakeCli(calls) });
  assert.deepEqual(again.events, []);
});
