'use strict';

// Local CLI processes, a real task store and the feed's state files only.
// No model, network or member run is needed to report a waiting chat.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const feed = require('../lib/feed-core');
const tasks = require('../lib/task-db');
const { project } = require('./helpers/feed-project');

const BIN = path.join(__dirname, '..', 'bin', 'atris.js');

function cli(ctx, args, env = ctx.env) {
  return spawnSync(process.execPath, [BIN, 'feed', ...args], {
    cwd: ctx.root, env: { ...env, NODE_NO_WARNINGS: '1' }, encoding: 'utf8', timeout: 15000,
  });
}

function json(ctx, args) {
  const run = cli(ctx, [...args, '--json']);
  assert.equal(run.status, 0, `${run.stderr}${run.stdout}`);
  return JSON.parse(run.stdout);
}

function set(ctx, session, ask = 'May I release the Mac app?', extra = []) {
  return json(ctx, ['waiting', 'set', '--session', session, '--ask', ask, ...extra]).waiting;
}

function stateFile(ctx) {
  return path.join(ctx.root, '.atris', 'state', 'feed', 'waiting.json');
}

function age(ctx, session, hours) {
  const file = stateFile(ctx);
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  const entry = state.entries.find((item) => item.session === session);
  entry.created_at = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  entry.updated_at = entry.created_at;
  fs.writeFileSync(file, JSON.stringify(state));
  return entry.created_at;
}

function idea(ctx, title = 'Call the ten oldest leads') {
  return feed.proposeCard(ctx.root, { as: 'scout', title, why: 'More people buy', env: ctx.env }).card;
}

test('waiting: set puts a complete question first in both filters and human output', (t) => {
  const ctx = project(t);
  const proposed = idea(ctx);
  const entry = set(ctx, 'mac-release', 'May I release the Mac app?', ['--title', 'Mac release', '--engine', 'codex']);
  for (const filter of ['all', 'needs_decision']) {
    const out = json(ctx, ['cards', '--filter', filter]);
    assert.equal(out.version, 'atris.feed.v1');
    assert.equal(out.counts.needs_decision, 2);
    assert.equal(out.cards[1].id, proposed.id);
    const card = out.cards[0];
    assert.ok(!card.id.startsWith('task:'));
    assert.deepEqual({
      kind: card.kind, source: card.source, author: card.author.name, title: card.title, body: card.body,
      state: card.state, needs_decision: card.needs_decision, decision: card.decision,
      why: card.why, can_decide: card.can_decide, cannot_decide_reason: card.cannot_decide_reason, created_at: card.created_at,
    }, {
      kind: 'question', source: { type: 'session', id: 'mac-release' }, author: 'Mac release', title: 'Mac release',
      body: 'May I release the Mac app?', state: 'pending', needs_decision: true, decision: null,
      why: 'This chat stopped and needs your answer.', can_decide: false, cannot_decide_reason: 'Answer in that chat window.',
      created_at: entry.created_at,
    });
    const text = cli(ctx, ['cards', '--filter', filter]);
    assert.equal(text.status, 0, text.stderr);
    assert.ok(text.stdout.indexOf('Mac release') < text.stdout.indexOf(proposed.title));
    assert.ok(text.stdout.includes('May I release the Mac app?'));
  }
  assert.equal(json(ctx, ['waiting', 'list']).waiting[0].engine, 'codex');
});

test('waiting: sessions sort oldest first without moving existing cards relative to each other', (t) => {
  const ctx = project(t);
  idea(ctx);
  idea(ctx, 'Thank the first ten buyers');
  json(ctx, ['say', 'I called the oldest leads.']);
  const before = json(ctx, ['cards']).cards.map((card) => card.id);
  set(ctx, 'newer');
  set(ctx, 'older');
  age(ctx, 'older', 2);
  age(ctx, 'newer', 1);
  for (const filter of ['all', 'needs_decision']) {
    const cards = json(ctx, ['cards', '--filter', filter]).cards;
    assert.deepEqual(cards.slice(0, 2).map((card) => card.source.id), ['older', 'newer']);
    const existing = cards.filter((card) => card.source.type !== 'session').map((card) => card.id);
    assert.deepEqual(existing, filter === 'all' ? before : before.filter((id) => id.startsWith('task:')));
  }
  assert.deepEqual(json(ctx, ['waiting', 'list']).waiting.map((entry) => entry.session), ['older', 'newer']);
  const delta = json(ctx, ['cards', '--since', '1']).cards;
  assert.deepEqual(delta.slice(0, 2).map((card) => card.source.id), ['older', 'newer']);
});

test('waiting: setting twice replaces the ask and keeps the first time and stable id', (t) => {
  const ctx = project(t);
  set(ctx, 'release:one / two');
  const created = age(ctx, 'release:one / two', 1);
  const first = json(ctx, ['cards']).cards[0];
  set(ctx, 'release:one / two', 'May I send the finished build?', ['--title', 'Release check']);
  const cards = json(ctx, ['cards']).cards;
  assert.equal(cards.length, 1);
  assert.equal(cards[0].id, first.id);
  assert.equal(cards[0].body, 'May I send the finished build?');
  assert.equal(cards[0].created_at, created);
  assert.equal(cards[0].title, 'Release check');
  assert.equal(json(ctx, ['waiting', 'list']).waiting.length, 1);
  assert.equal(feed.readCard(ctx.root, first.id, { env: ctx.env }).body, cards[0].body);
});

test('waiting: clear removes only that session and an unknown session succeeds quietly', (t) => {
  const ctx = project(t);
  set(ctx, 'one');
  set(ctx, 'two');
  for (const session of ['one', 'unknown', 'one']) {
    const run = cli(ctx, ['waiting', 'clear', '--session', session]);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout, '');
    assert.equal(run.stderr, '');
  }
  assert.deepEqual(json(ctx, ['cards']).cards.map((card) => card.source.id), ['two']);
  assert.deepEqual(json(ctx, ['waiting', 'list']).waiting.map((entry) => entry.session), ['two']);
});

test('waiting: decide is refused with the answer-in-chat reason and starts nothing', (t) => {
  const ctx = project(t);
  set(ctx, 'release');
  const card = json(ctx, ['cards']).cards[0];
  const events = ctx.db.prepare('SELECT COUNT(*) AS n FROM task_events').get().n;
  for (const choice of ['approve', 'dismiss']) {
    const run = cli(ctx, ['decide', card.id, choice, '--json']);
    assert.equal(run.status, 1);
    const out = JSON.parse(run.stdout);
    assert.equal(out.ok, false);
    assert.deepEqual(out.error, { status: 409, message: 'Answer in that chat window.' });
    assert.throws(() => feed.decide(ctx.root, card.id, choice, { env: ctx.env, deps: ctx.deps }),
      (error) => error.status === 409 && error.message === 'Answer in that chat window.');
  }
  const agent = cli(ctx, ['decide', card.id, 'approve', '--json'], ctx.agentEnv);
  assert.equal(agent.status, 1);
  assert.equal(JSON.parse(agent.stdout).error.status, 409);
  assert.deepEqual(ctx.spawned, []);
  assert.deepEqual(feed.readRuns(ctx.root), []);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM task_events').get().n, events);
  assert.equal(json(ctx, ['cards']).cards[0].id, card.id);
});

test('waiting: three passes leave an old waiting card in place with no saved passes', (t) => {
  const ctx = project(t);
  set(ctx, 'release');
  age(ctx, 'release', 1);
  const before = fs.readFileSync(stateFile(ctx), 'utf8');
  const card = json(ctx, ['cards']).cards[0];
  for (let i = 0; i < 3; i += 1) {
    const out = json(ctx, ['pass', card.id]);
    assert.equal(out.passed, 0);
    assert.deepEqual(out.skipped, [card.id]);
  }
  const out = json(ctx, ['cards']);
  assert.equal(out.cards[0].id, card.id);
  assert.equal(out.cards[0].pass_count, 0);
  assert.equal(out.counts.parked, 0);
  assert.deepEqual(json(ctx, ['cards', '--filter', 'parked']).cards, []);
  assert.equal(fs.readFileSync(stateFile(ctx), 'utf8'), before);
});

test('waiting: a 25 hour old entry disappears from cards and list and can start waiting afresh', (t) => {
  const ctx = project(t);
  set(ctx, 'stale');
  set(ctx, 'live');
  const old = age(ctx, 'stale', 25);
  for (const filter of ['all', 'needs_decision']) {
    assert.deepEqual(json(ctx, ['cards', '--filter', filter]).cards.map((card) => card.source.id), ['live']);
  }
  assert.deepEqual(json(ctx, ['waiting', 'list']).waiting.map((entry) => entry.session), ['live']);
  const refreshed = set(ctx, 'stale', 'May I send this now?');
  assert.notEqual(refreshed.created_at, old);
  assert.equal(json(ctx, ['cards']).cards.length, 2);
});

test('waiting: missing names use the desktop author shape and length limits trim without errors', (t) => {
  const ctx = project(t);
  set(ctx, '  trimmed  ', `  ${'a'.repeat(450)}  `, ['--title', `  ${'b'.repeat(90)}  `]);
  let card = json(ctx, ['cards']).cards[0];
  assert.equal(card.source.id, 'trimmed');
  assert.equal(card.body, 'a'.repeat(400));
  assert.equal(card.title, 'b'.repeat(80));
  assert.equal(card.author.name, card.title);
  set(ctx, 'trimmed', '  May I send it?  ');
  card = json(ctx, ['cards']).cards[0];
  assert.equal(card.author.name, 'Chat window');
  assert.equal(card.title, 'A chat is waiting on you');
  assert.equal(card.body, 'May I send it?');
  const text = cli(ctx, ['waiting', 'list']);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /Chat window \(trimmed\): May I send it\?/);
});

test('waiting: empty session or ask is refused on one plain line with a failing exit', (t) => {
  const ctx = project(t);
  for (const args of [
    ['waiting', 'set', '--session', '', '--ask', 'May I send it?'],
    ['waiting', 'set', '--session', '   ', '--ask', 'May I send it?'],
    ['waiting', 'set', '--ask', 'May I send it?'],
    ['waiting', 'set', '--session', 'release', '--ask', '   '],
    ['waiting', 'set', '--session', 'release'],
    ['waiting', 'clear', '--session', ''],
    ['waiting', 'clear'],
  ]) {
    const run = cli(ctx, args);
    assert.equal(run.status, 1, run.stdout);
    assert.match(run.stderr, /^error: [^\n]+\n$/);
    assert.equal(run.stdout, '');
  }
  assert.deepEqual(json(ctx, ['waiting', 'list']).waiting, []);
});

test('waiting: entries never count toward idea limits or merge with an idea', (t) => {
  const ctx = project(t);
  const title = 'Call the ten oldest leads';
  for (let i = 0; i < 12; i += 1) set(ctx, `window-${i}`, title, ['--title', 'scout']);
  assert.equal(feed._internal.waitingIdeaCounts(ctx.root).size, 0);
  assert.deepEqual(feed._internal.ideaRows(ctx.root), []);
  const proposed = feed.proposeCard(ctx.root, {
    as: 'scout', title, why: 'More people buy', env: { ...ctx.env, ATRIS_FEED_MAX_PENDING_PER_AUTHOR: '1' },
  }).card;
  assert.equal(proposed.kind, 'proposal');
  assert.equal(proposed.backer_count, 0);
  const out = json(ctx, ['cards']);
  assert.equal(out.cards.length, 13);
  assert.equal(out.cards.at(-1).id, proposed.id);
  assert.equal(feed._internal.waitingIdeaCounts(ctx.root).get('agent:scout'), 1);
  // Many waiting chats must not turn a sparse idea queue into a full one.
  ctx.db.prepare('UPDATE tasks SET created_at = ? WHERE id = ?').run(Date.now() - 3600000, proposed.source.id);
  assert.equal(json(ctx, ['pass', proposed.id]).passed, 1);
  tasks.updateTaskMetadata(ctx.db, proposed.source.id, (metadata) => {
    metadata.feed_views[proposed.id]['user:owner'].last_passed_at = new Date(Date.now() - 6 * 60000).toISOString();
    return metadata;
  }, { touch: false });
  assert.ok(json(ctx, ['cards']).cards.some((card) => card.id === proposed.id), 'a sparse queue still uses the short rest');
});

function child(ctx, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, args, { cwd: ctx.root, env: { ...ctx.env, NODE_NO_WARNINGS: '1' } });
    let out = '';
    let err = '';
    proc.stdout.on('data', (data) => { out += data; });
    proc.stderr.on('data', (data) => { err += data; });
    proc.on('error', reject);
    proc.on('close', (status) => resolve({ status, out, err }));
  });
}

test('waiting: simultaneous sessions save every ask whole through the real CLI', async (t) => {
  const ctx = project(t);
  const writes = await Promise.all(Array.from({ length: 12 }, (_, i) => child(ctx,
    [BIN, 'feed', 'waiting', 'set', '--session', `window-${i}`, '--ask', `May I send item ${i}?`, '--json'])));
  for (const write of writes) assert.equal(write.status, 0, `${write.err}${write.out}`);
  const entries = json(ctx, ['waiting', 'list']).waiting;
  assert.equal(entries.length, 12);
  for (let i = 0; i < 12; i += 1) assert.equal(entries.find((entry) => entry.session === `window-${i}`).ask, `May I send item ${i}?`);
  assert.deepEqual(fs.readdirSync(path.dirname(stateFile(ctx))).filter((name) => /\.tmp$|\.lock$/.test(name)), []);
});

test('waiting: writes wait out a short lock and a busy lock has the existing retryable error shape', async (t) => {
  const ctx = project(t);
  set(ctx, 'release');
  const lock = path.join(path.dirname(stateFile(ctx)), 'waiting.lock');
  fs.writeFileSync(lock, '');
  const release = child(ctx, ['-e', 'setTimeout(() => require("fs").unlinkSync(process.argv[1]), 300)', lock]);
  const write = await child(ctx, [BIN, 'feed', 'waiting', 'set', '--session', 'other', '--ask', 'May I send it?', '--json']);
  assert.equal((await release).status, 0);
  assert.equal(write.status, 0, `${write.err}${write.out}`);
  const saved = fs.readFileSync(stateFile(ctx), 'utf8');
  fs.writeFileSync(lock, '');
  const blocked = cli(ctx, ['waiting', 'set', '--session', 'third', '--ask', 'May I send it?', '--json']);
  assert.equal(blocked.status, 1);
  const out = JSON.parse(blocked.stdout);
  assert.equal(out.ok, false);
  assert.equal(out.error.status, 503);
  assert.equal(out.error.code, 'busy');
  assert.equal(out.error.busy, true);
  assert.equal(fs.readFileSync(stateFile(ctx), 'utf8'), saved);
  assert.equal(json(ctx, ['cards']).cards.length, 2, 'reads see the previous complete file while a writer is busy');
});

test('waiting: commands work without a task database and help names all three forms', (t) => {
  const ctx = project(t);
  tasks.close();
  fs.unlinkSync(ctx.env.ATRIS_TASKS_DB);
  set(ctx, 'release');
  const card = json(ctx, ['cards']).cards[0];
  assert.ok(card);
  assert.equal(json(ctx, ['pass', card.id]).passed, 0);
  assert.equal(cli(ctx, ['decide', card.id, 'approve']).status, 1);
  assert.equal(fs.existsSync(ctx.env.ATRIS_TASKS_DB), false, 'waiting verbs never create a task database');
  const help = cli(ctx, ['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /atris feed waiting set --session <id> --ask/);
  assert.match(help.stdout, /atris feed waiting clear --session <id>/);
  assert.match(help.stdout, /atris feed waiting list \[--json\]/);
});

test('waiting: background member runs skip set and clear without writing state while list still works', (t) => {
  const ctx = project(t);
  const bgEnv = { ...ctx.env, ATRIS_AGENT_PROOF_ONLY: '1' };
  const feedDir = path.dirname(stateFile(ctx));

  const bgSetJson = cli(ctx, ['waiting', 'set', '--session', 'bg-run', '--ask', 'May I ship this?', '--json'], bgEnv);
  assert.equal(bgSetJson.status, 0, `${bgSetJson.stderr}${bgSetJson.stdout}`);
  assert.deepEqual(JSON.parse(bgSetJson.stdout), {
    version: 'atris.feed.v1',
    skipped: true,
    reason: 'background_member_run',
  });
  const bgSetText = cli(ctx, ['waiting', 'set', '--session', 'bg-run', '--ask', 'May I ship this?'], bgEnv);
  assert.equal(bgSetText.status, 0, `${bgSetText.stderr}${bgSetText.stdout}`);
  assert.equal(bgSetText.stdout.trim(), 'skipped: background member run.');
  assert.equal(fs.existsSync(stateFile(ctx)), false);
  assert.equal(fs.existsSync(feedDir), false);
  assert.deepEqual(json(ctx, ['cards']).cards, []);

  const bgClearEmpty = cli(ctx, ['waiting', 'clear', '--session', 'bg-run', '--json'], bgEnv);
  assert.equal(bgClearEmpty.status, 0, `${bgClearEmpty.stderr}${bgClearEmpty.stdout}`);
  assert.deepEqual(JSON.parse(bgClearEmpty.stdout), {
    version: 'atris.feed.v1',
    skipped: true,
    reason: 'background_member_run',
  });
  assert.equal(fs.existsSync(stateFile(ctx)), false);
  assert.equal(fs.existsSync(feedDir), false);

  // Normal human waiting set still creates the waiting card as before.
  set(ctx, 'human-chat', 'May I release the Mac app?');
  assert.deepEqual(json(ctx, ['waiting', 'list']).waiting.map((entry) => entry.session), ['human-chat']);

  // Background clear must not wipe an existing human waiting card.
  const bgClear = cli(ctx, ['waiting', 'clear', '--session', 'human-chat', '--json'], bgEnv);
  assert.equal(bgClear.status, 0, `${bgClear.stderr}${bgClear.stdout}`);
  assert.deepEqual(JSON.parse(bgClear.stdout), {
    version: 'atris.feed.v1',
    skipped: true,
    reason: 'background_member_run',
  });
  assert.deepEqual(json(ctx, ['waiting', 'list']).waiting.map((entry) => entry.session), ['human-chat']);

  // Background list still works normally.
  const bgList = cli(ctx, ['waiting', 'list', '--json'], bgEnv);
  assert.equal(bgList.status, 0, `${bgList.stderr}${bgList.stdout}`);
  assert.deepEqual(JSON.parse(bgList.stdout).waiting.map((entry) => entry.session), ['human-chat']);
});

test('waiting: clear on a fresh workspace without waiting.json succeeds and writes nothing', (t) => {
  const ctx = project(t);
  const feedDir = path.dirname(stateFile(ctx));
  assert.equal(fs.existsSync(stateFile(ctx)), false);
  assert.equal(fs.existsSync(feedDir), false);

  const run = cli(ctx, ['waiting', 'clear', '--session', 'missing']);
  assert.equal(run.status, 0, `${run.stderr}${run.stdout}`);
  assert.equal(run.stdout, '');
  assert.equal(run.stderr, '');
  assert.equal(fs.existsSync(stateFile(ctx)), false, 'clear must not create waiting.json');
  assert.equal(fs.existsSync(path.join(feedDir, 'waiting.lock')), false, 'clear must not create waiting.lock');
  assert.equal(fs.existsSync(feedDir), false, 'clear must not create .atris/state/feed');

  const invalid = cli(ctx, ['waiting', 'clear', '--session', '   ']);
  assert.equal(invalid.status, 1);
  assert.equal(fs.existsSync(stateFile(ctx)), false);
});
