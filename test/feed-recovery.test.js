'use strict';

// Never stuck, always recovers: a model that is missing or fails mid-run, a
// run past its time limit, a restart in the middle of work, two commands at
// once, no network on a cloud model, a reply that fails, the repair command
// and the ready check. Every engine and run here is a stand-in.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const tasks = require('../lib/task-db');
const feed = require('../lib/feed-core');
const team = require('../lib/feed-team');
const { project } = require('./helpers/feed-project');

const CLI = path.join(__dirname, '..', 'bin', 'atris.js');

function propose(ctx, fields = {}) {
  return feed.proposeCard(ctx.root, { as: 'scout', title: 'Call the ten oldest leads', why: 'Old leads answer more often', env: ctx.env, ...fields }).card;
}

function approved(ctx, fields) {
  const card = propose(ctx, fields);
  feed.decide(ctx.root, card.id, 'approve', { env: ctx.env, deps: ctx.deps });
  return { card, entry: feed.readRuns(ctx.root).find((e) => e.card_id === card.id) };
}

function cardOf(ctx, id, filter = 'all') {
  return feed.listCards(ctx.root, { filter, limit: 100, env: ctx.env }).cards.find((c) => c.id === id);
}

function setRun(ctx, id, change) {
  const file = path.join(ctx.root, '.atris', 'state', 'feed', 'runs.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  Object.assign(data.entries.find((e) => e.id === id), change);
  fs.writeFileSync(file, JSON.stringify(data));
}

const finish = (ctx, cardId) => team.emit(ctx.root, { as: 'scout', type: 'result', card: cardId, proof: 'Called them; three said yes.', env: ctx.env });

test('recover: a model missing at the start sends the card back with a plain reason, and the next approve works', async (t) => {
  const ctx = project(t);
  const card = propose(ctx);
  await feed.talk(ctx.root, card.id, 'Five is enough', { env: ctx.env, deps: ctx.deps });
  feed.decide(ctx.root, card.id, 'approve', { env: ctx.env, deps: ctx.deps });
  const entry = feed.readRuns(ctx.root).find((e) => e.card_id === card.id);
  fs.writeFileSync(path.join(ctx.root, 'atris', '.config'), JSON.stringify({ feed: { default_engine: 'grok' } }));
  await feed.runEntry(ctx.root, entry.id, { ...ctx.deps, spawnSync: () => assert.fail('nothing runs without a model') });
  const back = cardOf(ctx, card.id);
  assert.equal(back.needs_decision, true);
  assert.equal(back.decision, null);
  assert.match(back.last_failure.reason, /Grok cannot run here/);
  assert.equal(back.message_count, 2, 'nothing is lost');
  assert.equal(feed.readRuns(ctx.root).find((e) => e.id === entry.id).status, 'failed');
  fs.writeFileSync(path.join(ctx.root, 'atris', '.config'), JSON.stringify({ feed: { default_engine: 'codex' } }));
  const again = feed.decide(ctx.root, card.id, 'approve', { env: ctx.env, deps: ctx.deps });
  assert.equal(again.outcome.started, true);
  assert.equal(again.replayed, false);
});

test('recover: a run that fails mid-way goes back to waiting; one that wrote its result keeps it', async (t) => {
  const ctx = project(t);
  const failing = approved(ctx);
  await feed.runEntry(ctx.root, failing.entry.id, { ...ctx.deps, spawnSync: () => ({ status: 1 }), memberStillWorking: () => false });
  assert.match(cardOf(ctx, failing.card.id).last_failure.reason, /ended without a result/);
  const good = approved(ctx, { as: 'writer', title: 'Write the spring price note' });
  await feed.runEntry(ctx.root, good.entry.id, {
    ...ctx.deps,
    spawnSync: () => {
      team.emit(ctx.root, { as: 'writer', type: 'result', card: good.card.id, proof: 'Wrote it; it reads well.', env: ctx.env });
      return { status: 1 };
    },
  });
  assert.equal(tasks.getTask(ctx.db, good.card.source.id).status, 'review', 'the result is kept even though the run then failed');
  assert.equal(feed.readRuns(ctx.root).find((e) => e.id === good.entry.id).status, 'ended');
});

test('recover: a run past its time limit is stopped; a result already written is kept, otherwise the card says so', async (t) => {
  const ctx = project(t);
  const env = { ...process.env };
  process.env.ATRIS_FEED_WORK_LIMIT_MINUTES = '0.05';
  t.after(() => { if (env.ATRIS_FEED_WORK_LIMIT_MINUTES === undefined) delete process.env.ATRIS_FEED_WORK_LIMIT_MINUTES; });
  const slow = approved(ctx);
  let limit = null;
  await feed.runEntry(ctx.root, slow.entry.id, {
    ...ctx.deps,
    spawnSync: (_cmd, _args, opts) => { limit = opts.timeout; return { status: null, signal: 'SIGTERM', error: { code: 'ETIMEDOUT' } }; },
  });
  assert.equal(limit, 3000, 'the run is given its limit');
  assert.equal(feed.readRuns(ctx.root).find((e) => e.id === slow.entry.id).status, 'timed_out');
  assert.match(cardOf(ctx, slow.card.id).last_failure.reason, /stopped after/);
  const kept = approved(ctx, { title: 'Write the spring price note' });
  await feed.runEntry(ctx.root, kept.entry.id, {
    ...ctx.deps,
    spawnSync: () => { finish(ctx, kept.card.id); return { status: null, signal: 'SIGTERM', error: { code: 'ETIMEDOUT' } }; },
  });
  assert.equal(tasks.getTask(ctx.db, kept.card.source.id).status, 'review', 'the result written before the limit is kept');
  assert.equal(feed.readRuns(ctx.root).find((e) => e.id === kept.entry.id).status, 'ended');
});

test('recover: after a restart, finished results are picked up, dead runs cleared, their cards wait again, and the line moves in order', (t) => {
  const ctx = project(t, ['scout', 'writer', 'closer', 'extra']);
  const done = approved(ctx, { as: 'scout', title: 'Call the warm leads today' });
  const lost = approved(ctx, { as: 'writer', title: 'Write the spring price note' });
  const next1 = approved(ctx, { as: 'closer', title: 'Ask three owners for a quote' });
  const next2 = approved(ctx, { as: 'extra', title: 'Thank the first ten buyers' });
  assert.equal(next1.entry.status, 'queued');
  finish(ctx, done.card.id);
  tasks.claimTask(ctx.db, { id: lost.card.source.id, claimedBy: 'writer' });
  // The machine restarted: every runner process is gone.
  const deadPids = new Set([process.pid]);
  const spawnedAfter = [];
  const out = team.repair(ctx.root, { env: ctx.env, deps: { isAlive: (pid) => !deadPids.has(pid), spawnRunner: (_r, e) => { spawnedAfter.push(e.card_id); return 424242; }, memberStillWorking: () => false } });
  assert.ok(out.fixed.some((line) => /restarted/.test(line)), out.fixed.join('\n'));
  assert.equal(tasks.getTask(ctx.db, done.card.source.id).status, 'review', 'the finished result is kept');
  const back = cardOf(ctx, lost.card.id);
  assert.equal(back.needs_decision, true);
  assert.match(back.last_failure.reason, /restarted/);
  assert.equal(tasks.getTask(ctx.db, lost.card.source.id).status, 'open', 'the claim is let go');
  assert.deepEqual(spawnedAfter, [next1.card.id, next2.card.id], 'the line resumes in order');
});

test('recover: a run alive but long past its limit is stopped by the next command', (t) => {
  const ctx = project(t);
  const { card, entry } = approved(ctx);
  setRun(ctx, entry.id, { pid: 999999, started_at: new Date(Date.now() - 3 * 3600000).toISOString() });
  feed.pump(ctx.root, { ...ctx.deps, isAlive: () => true, memberStillWorking: () => false });
  assert.equal(feed.readRuns(ctx.root).find((e) => e.id === entry.id).status, 'timed_out');
  assert.match(cardOf(ctx, card.id).last_failure.reason, /stopped after 45 minutes/);
});

function runCli(cwd, args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ code, out }));
  });
}

test('recover: two commands at once never start the same work twice or break the state file', async (t) => {
  const ctx = project(t, ['scout', 'writer', 'closer', 'extra']);
  const fake = path.join(ctx.dir, 'starts.txt');
  const env = { ...ctx.env, ATRIS_FEED_FAKE_RUNNER: fake, NODE_TEST_CONTEXT: process.env.NODE_TEST_CONTEXT || 'child' };
  const card = propose(ctx);
  const same = await Promise.all([1, 2, 3, 4].map(() => runCli(ctx.root, ['feed', 'decide', card.id, 'approve', '--json'], env)));
  const answers = same.map((r) => JSON.parse(r.out));
  assert.equal(answers.filter((a) => a.replayed === false).length, 1, 'one decision');
  assert.equal(fs.readFileSync(fake, 'utf8').trim().split('\n').length, 1, 'one start');
  const others = ['writer', 'closer', 'extra'].map((as, i) => propose(ctx, { as, title: ['Write the spring price note', 'Ask three owners for a quote', 'Thank the first ten buyers'][i] }));
  await Promise.all(others.map((c) => runCli(ctx.root, ['feed', 'decide', c.id, 'approve', '--json'], env)));
  const runs = JSON.parse(fs.readFileSync(path.join(ctx.root, '.atris', 'state', 'feed', 'runs.json'), 'utf8'));
  assert.equal(runs.entries.length, 4, 'no entry lost');
  assert.equal(new Set(runs.entries.map((e) => e.card_id)).size, 4);
  assert.equal(runs.entries.filter((e) => e.status === 'running').length, 2);
});

test('recover: no network on a cloud model says so plainly; the message stays and a resend on a local model works', async (t) => {
  const ctx = project(t);
  const card = propose(ctx);
  fs.writeFileSync(path.join(ctx.root, 'atris', '.config'), JSON.stringify({ feed: { default_engine: 'atris-fast' } }));
  const offline = { ...ctx.deps, turn: async () => ({ ok: false, error: 'getaddrinfo ENOTFOUND api.atris.ai' }) };
  const out = await feed.talk(ctx.root, card.id, 'Five is enough', { env: { ...ctx.env, ATRIS_TOKEN: 'x' }, deps: offline });
  assert.match(out.reply_error, /could not be reached/);
  assert.match(out.reply.text, /could not answer just now/);
  assert.equal(out.reply_pending, false, 'no endless typing');
  fs.writeFileSync(path.join(ctx.root, 'atris', '.config'), JSON.stringify({ feed: { default_engine: 'codex' } }));
  const resend = await feed.talk(ctx.root, card.id, 'Five is enough', { env: ctx.env, deps: ctx.deps });
  assert.equal(resend.reply_error, null);
  const thread = feed.listMessages(ctx.root, card.id, { env: ctx.env }).messages;
  assert.equal(thread.filter((m) => m.text === 'Five is enough').length, 2, 'both sends kept');
});

test('recover: a reply that throws leaves the message, no pending reply, and the person can send again', async (t) => {
  const ctx = project(t);
  const card = propose(ctx);
  const boom = { ...ctx.deps, turn: async () => { throw new Error('the engine fell over'); } };
  await assert.rejects(feed.talk(ctx.root, card.id, 'Hello?', { env: ctx.env, deps: boom }));
  const thread = feed.listMessages(ctx.root, card.id, { env: ctx.env });
  assert.equal(thread.messages.length, 1);
  assert.equal(thread.reply_pending, false);
  assert.ok((await feed.talk(ctx.root, card.id, 'Hello?', { env: ctx.env, deps: ctx.deps })).reply);
});

test('recover: a broken run list is kept aside and the line starts fresh, without a crash', (t) => {
  const ctx = project(t);
  const file = path.join(ctx.root, '.atris', 'state', 'feed', 'runs.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{"entries": [ {"id": broken');
  const { card } = approved(ctx);
  assert.equal(cardOf(ctx, card.id, 'working').state, 'working');
  assert.ok(fs.readdirSync(path.dirname(file)).some((name) => name.startsWith('runs.json.broken-')), 'the broken copy is kept');
});

test('repair: says what it fixed, clears a reply that never came, and resumes the line', (t) => {
  const ctx = project(t);
  const card = propose(ctx);
  tasks.updateTaskMetadata(ctx.db, card.source.id, (m) => {
    m.feed.thread = { message_count: 1, reply_pending: true, last_message_at: new Date(Date.now() - 600000).toISOString() };
    return m;
  });
  const out = team.repair(ctx.root, { env: ctx.env, deps: ctx.deps });
  assert.ok(out.fixed.some((line) => /reply that never came/.test(line)));
  assert.equal(feed.listMessages(ctx.root, card.id, { env: ctx.env }).reply_pending, false);
  assert.deepEqual(team.repair(ctx.root, { env: ctx.env, deps: ctx.deps }).fixed, [], 'a second run finds nothing');
  assert.throws(() => team.repair(ctx.root, { env: ctx.agentEnv, deps: ctx.deps }), (e) => e.status === 403);
});

test('doctor: ready when everything is, and names the one thing to do when not', async (t) => {
  const ctx = project(t);
  let out = await team.doctor(ctx.root, { env: ctx.env, deps: ctx.deps });
  assert.equal(out.ready, false);
  const goal = out.checks.find((c) => c.name === 'goal');
  assert.equal(goal.ok, false);
  assert.match(goal.fix, /atris feed theme set/);
  feed.setTheme(ctx.root, 'Get ten paying customers by December', { env: ctx.env });
  out = await team.doctor(ctx.root, { env: ctx.env, deps: ctx.deps });
  assert.equal(out.ready, true, JSON.stringify(out.checks.filter((c) => !c.ok)));
  assert.ok(out.checks.find((c) => c.name === 'model codex').ok);
  // Something stuck makes it not ready, and repair is the fix.
  const { entry } = approved(ctx);
  setRun(ctx, entry.id, { pid: 999999 });
  out = await team.doctor(ctx.root, { env: ctx.env, deps: { ...ctx.deps, isAlive: () => false } });
  const stuck = out.checks.find((c) => c.name === 'nothing stuck');
  assert.equal(stuck.ok, false);
  assert.match(stuck.fix, /atris feed repair/);
  // A model that does not answer.
  out = await team.doctor(ctx.root, { env: ctx.env, deps: { ...ctx.deps, turn: async () => ({ ok: false, error: 'not signed in' }) } });
  assert.equal(out.checks.find((c) => c.name === 'model codex').ok, false);
  const bare = await runCli(ctx.dir, ['feed', 'doctor', '--no-call', '--json'], ctx.env);
  assert.equal(bare.code, 1, 'not ready exits non-zero');
  assert.equal(JSON.parse(bare.out).checks[0].name, 'project');
});

test('recover: a card that came back says which try it is, with each earlier miss and its reason', async (t) => {
  const ctx = project(t);
  const { card, entry } = approved(ctx);
  assert.equal(cardOf(ctx, card.id, 'working').attempt, 1, 'the first try');
  await feed.runEntry(ctx.root, entry.id, { ...ctx.deps, spawnSync: () => ({ status: 1 }), memberStillWorking: () => false });
  const once = cardOf(ctx, card.id);
  assert.equal(once.attempt, 2, 'one miss: the next is the second try');
  assert.equal(once.misses.length, 1);
  assert.match(once.misses[0].reason, /ended without a result/);
  feed.decide(ctx.root, card.id, 'approve', { env: ctx.env, deps: ctx.deps });
  const again = feed.readRuns(ctx.root).filter((e) => e.card_id === card.id).pop();
  await feed.runEntry(ctx.root, again.id, { ...ctx.deps, spawnSync: () => ({ status: 1 }), memberStillWorking: () => false });
  const twice = cardOf(ctx, card.id);
  assert.equal(twice.attempt, 3);
  assert.equal(twice.misses.length, 2);
  assert.equal(twice.id, card.id, 'the card keeps its place');
});

test('trail: an opened card lists what happened, oldest first, with who and when', async (t) => {
  const ctx = project(t);
  const { card, entry } = approved(ctx);
  team.emit(ctx.root, { as: 'scout', type: 'progress', card: card.id, text: 'Found the ten oldest leads.', env: ctx.env });
  let trail = cardOf(ctx, card.id, 'working').trail;
  assert.deepEqual(trail.map((s) => [s.by, s.text]), [['you', 'You approved it.'], ['scout', 'Started.'], ['scout', 'Found the ten oldest leads.']]);
  assert.ok(trail.every((s) => !Number.isNaN(Date.parse(s.at))), 'every line has its time');
  await feed.runEntry(ctx.root, entry.id, { ...ctx.deps, spawnSync: () => ({ status: 1 }), memberStillWorking: () => false });
  trail = cardOf(ctx, card.id).trail;
  assert.equal(trail.at(-1).kind, 'miss');
  assert.match(trail.at(-1).text, /^Stopped without finishing\. .*ended without a result/);
  assert.ok(trail.some((s) => s.text === 'Found the ten oldest leads.'), 'what the teammate said before is kept');
});

test('trail: the start note asks the teammate for one plain line at each step', (t) => {
  const ctx = project(t);
  const { card } = approved(ctx);
  const row = tasks.open(process.env.ATRIS_TASKS_DB).prepare('SELECT metadata FROM tasks WHERE id = ?').get(card.id.split(':')[1]);
  const objective = JSON.parse(row.metadata).objective;
  assert.match(objective, /As you work, write one plain line at each step/);
  assert.match(objective, new RegExp(`atris feed emit --as scout progress --card ${card.id.replace(/[:]/g, '[:]')}`));
});
