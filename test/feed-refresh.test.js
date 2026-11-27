'use strict';

// Refresh is the person asking "what is new?": the awake team reads the
// project's records, the work under way and the discussion, and brings a new
// idea, an honest update, or nothing. These drive the real command line in
// its own processes (`atris feed ping --reason refresh --stream --json`) with
// stand-in answers (ATRIS_FEED_FAKE_TURNS, honored only under node --test),
// so no model runs and nothing spends.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const feed = require('../lib/feed-core');
const room = require('../lib/feed-room');
const { project } = require('./helpers/feed-project');

const BIN = path.join(__dirname, '..', 'bin', 'atris.js');

function runCli(cwd, args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stdout, stderr, events: stdout.trim() ? stdout.trim().split('\n').map((l) => { try { return JSON.parse(l); } catch { return { raw: l }; } }) : [] }));
  });
}

function stand(ctx, rules) {
  const file = path.join(ctx.dir, 'turns.json');
  const log = path.join(ctx.dir, 'turns.jsonl');
  fs.writeFileSync(file, JSON.stringify({ log, rules }));
  return {
    env: { ...ctx.env, ATRIS_FEED_FAKE_TURNS: file, ATRIS_FEED_MEMBER_GAP_SECONDS: '0' },
    turns: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []),
  };
}

const IDEA = 'IDEA\nTITLE: Call the three buyers who asked about gift boxes\nWHY: They already asked\nBODY: Two asked on Tuesday.\nSOURCE: From the shop notes\nSOURCE_REF: atris/logs/2026/2026-11-14.md\nEND\n';

test('refresh in a new project with no goal: each awake member is asked once, reads the real records, and nothing is invented', async (t) => {
  const ctx = project(t, ['scout', 'writer']);
  // What the project actually has: a journal line, work under way, and a discussion on the person's post.
  fs.mkdirSync(path.join(ctx.root, 'atris', 'logs', '2026'), { recursive: true });
  fs.writeFileSync(path.join(ctx.root, 'atris', 'logs', '2026', '2026-11-14.md'), '# 2026-11-14\n\n- Two buyers asked about gift boxes on Tuesday.\n');
  const idea = feed.proposeCard(ctx.root, { as: 'writer', title: 'Rewrite the shop opening hours', why: 'People get them wrong', env: ctx.env });
  feed.decide(ctx.root, idea.card.id, 'approve', { env: ctx.env, deps: ctx.deps });
  require('../lib/feed-team').emit(ctx.root, { as: 'writer', type: 'progress', card: idea.card.id, text: 'The new hours are written, the shop page is next.', env: ctx.env });
  const card = room.say(ctx.root, { text: 'What should I do about gift boxes?', env: ctx.env }).card;
  room.reply(ctx.root, card.id, 'Gift boxes sold out twice last winter.', { as: 'scout', fromAsk: true, env: ctx.env });
  const sim = stand(ctx, [{ match: 'You are scout', text: IDEA }, { match: 'You are writer', text: '' }]);
  const runsBefore = feed.readRuns(ctx.root).length;
  const out = await runCli(ctx.root, ['feed', 'ping', '--reason', 'refresh', '--stream', '--json'], sim.env);
  assert.equal(out.code, 0, out.stderr);
  const turns = sim.turns();
  assert.deepEqual(turns.map((turn) => /You are ([a-z]+),/.exec(turn.prompt)[1]).sort(), ['scout', 'writer'], 'one turn for each awake member, no more');
  for (const { prompt } of turns) {
    assert.match(prompt, /The owner pressed refresh/);
    assert.match(prompt, /Project goal: none set yet/);
    assert.match(prompt, /Two buyers asked about gift boxes on Tuesday/, 'the journal');
    assert.match(prompt, /Rewrite the shop opening hours \(writer, being worked on; last update: The new hours are written, the shop page is next\.\)/, 'work under way, from its record');
    assert.match(prompt, /the owner: What should I do about gift boxes\?/, 'the person\'s post');
    assert.match(prompt, /scout \(you\) replied: Gift boxes sold out twice last winter\.|scout replied: Gift boxes sold out twice last winter\./, 'the discussion so far');
    assert.match(prompt, /never invent a goal or a purpose/);
  }
  const done = out.events.filter((e) => e.type === 'card_done');
  assert.equal(done.length, 1, 'the one new idea');
  assert.equal(out.events[out.events.length - 1].type, 'done');
  assert.equal(out.events[out.events.length - 1].pinged, 2);
  // The new idea is a real card; a member with nothing new wrote nothing.
  const titles = feed.listCards(ctx.root, { limit: 100, env: ctx.env }).cards.map((c) => c.title);
  assert.ok(titles.includes('Call the three buyers who asked about gift boxes'));
  assert.equal(feed.readRuns(ctx.root).length, runsBefore, 'refresh starts no work');
});

test('refresh twice at once (a double press, or two windows): the team is asked once, the second says it is still thinking', async (t) => {
  const ctx = project(t, ['scout', 'writer']);
  const release = path.join(ctx.dir, 'release-turns');
  const sim = stand(ctx, [{ match: 'You are', text: '', wait_for_file: release }]);
  const first = runCli(ctx.root, ['feed', 'ping', '--reason', 'refresh', '--stream', '--json'], sim.env);
  let a, second;
  try {
    const deadline = performance.now() + 15_000;
    while (sim.turns().length < 2 && performance.now() < deadline) await delay(20);
    assert.equal(sim.turns().length, 2, 'the first refresh reached both turns');
    second = await runCli(ctx.root, ['feed', 'ping', '--reason', 'refresh', '--stream', '--json'], sim.env);
  } finally {
    fs.writeFileSync(release, '');
    a = await first;
  }
  assert.equal(a.code, 0);
  assert.equal(second.code, 0);
  const end = second.events[second.events.length - 1];
  assert.equal(end.type, 'done');
  assert.equal(end.pinged, 0);
  assert.match(end.reason, /still thinking/);
  assert.equal(sim.turns().length, 2, 'two members, one turn each, never doubled');
  // Once they are done, a new refresh asks them again.
  const third = await runCli(ctx.root, ['feed', 'ping', '--reason', 'refresh', '--stream', '--json'], sim.env);
  assert.equal(third.events[third.events.length - 1].pinged, 2);
  assert.equal(sim.turns().length, 4);
});

test('refresh with nothing new, or a failing model, ends honestly with no card and no second try', async (t) => {
  const ctx = project(t, ['scout']);
  const sim = stand(ctx, [{ match: 'You are scout', ok: false, error: 'the model stopped' }]);
  const out = await runCli(ctx.root, ['feed', 'ping', '--reason', 'refresh', '--stream', '--json'], sim.env);
  assert.equal(out.code, 0);
  assert.equal(out.events.filter((e) => e.type === 'card_done').length, 0);
  assert.equal(out.events.filter((e) => e.type === 'retry').length, 0, 'a refresh never tries again by itself');
  assert.equal(sim.turns().length, 1);
  assert.equal(feed.listCards(ctx.root, { env: ctx.env }).cards.length, 0, 'nothing made up');
});

test('opening the feed and reading it asks nobody', async (t) => {
  const ctx = project(t, ['scout', 'writer']);
  room.say(ctx.root, { text: 'A first post', env: ctx.env });
  const sim = stand(ctx, [{ match: 'You are', text: IDEA }]);
  for (const args of [['feed', 'cards', '--json'], ['feed', 'members', '--json'], ['feed', 'theme', '--json'], ['feed', 'ping', '--help']]) {
    const out = await runCli(ctx.root, args, sim.env);
    assert.equal(out.code, 0, args.join(' '));
  }
  assert.equal(sim.turns().length, 0);
  assert.equal(fs.existsSync(path.join(ctx.root, '.atris', 'state', 'feed', 'pings.json')), false, 'no ask counted');
});

test('refresh and an empty team: nobody is asked and it says so', async (t) => {
  const ctx = project(t, ['scout'], { on: false });
  const sim = stand(ctx, [{ match: 'You are', text: IDEA }]);
  const out = await runCli(ctx.root, ['feed', 'ping', '--reason', 'refresh', '--stream', '--json'], sim.env);
  const end = out.events[out.events.length - 1];
  assert.equal(end.pinged, 0);
  assert.match(end.reason, /No team member is on/);
  assert.equal(sim.turns().length, 0);
});
