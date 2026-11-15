'use strict';

// spends: nothing (local feed reads and writes in a scratch folder; no engine, no network)
// The desktop opens the feed with a burst of reads while other processes
// write the task store. A read waits out a busy store for a few seconds, and
// one still busy after that answers with a plain JSON error a caller can test
// (error.busy), never a silent exit. Comments and ask counts written by
// several processes at the same moment all land.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const feed = require('../lib/feed-core');
const tasks = require('../lib/task-db');
const { project } = require('./helpers/feed-project');

const BIN = path.join(__dirname, '..', 'bin', 'atris.js');
const ROOM = path.join(__dirname, '..', 'lib', 'feed-room.js');

// Another process holds the store's write lock for ms, the way a long write
// does, so every other connection is told the store is busy.
const HOLD = `const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.argv[1]);
db.exec('PRAGMA locking_mode = EXCLUSIVE');
db.exec('BEGIN EXCLUSIVE');
process.stdout.write('held\\n');
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.argv[2]));
db.exec('COMMIT');
db.close();`;

function hold(file, ms) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', HOLD, file, String(ms)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    // Known from the start, so waiting for it after it already ended still returns.
    child.done = new Promise((done) => child.on('close', done));
    child.stderr.on('data', (d) => { err += d; });
    child.stdout.on('data', (d) => { if (String(d).includes('held')) resolve(child); });
    child.on('close', (code) => { if (code) reject(new Error(`the lock holder failed: ${err}`)); });
  });
}

function cli(ctx, args) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [BIN, 'feed', ...args], { cwd: ctx.root, env: { ...ctx.env, NODE_NO_WARNINGS: '1' } });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (status) => resolve({ status, out, err, ms: Date.now() - started }));
  });
}

function setup(t) {
  const ctx = project(t, ['scout', 'writer']);
  const card = feed.proposeCard(ctx.root, { as: 'scout', title: 'Call the warm leads today', why: 'More people buy', env: ctx.env }).card;
  tasks.close(); // this process keeps no connection open while another holds the lock
  return { ctx, card, file: ctx.env.ATRIS_TASKS_DB };
}

test('busy store: a burst of feed reads waits out a short write instead of failing', async (t) => {
  const { ctx, card, file } = setup(t);
  const holder = await hold(file, 1200);
  const reads = await Promise.all([
    cli(ctx, ['cards', '--json']), cli(ctx, ['cards', '--json']), cli(ctx, ['cards', '--filter', 'working', '--json']),
    cli(ctx, ['members', '--json']), cli(ctx, ['replies', card.id, '--json']), cli(ctx, ['messages', card.id, '--json']),
  ]);
  await holder.done;
  for (const read of reads) {
    assert.equal(read.status, 0, `${read.err}${read.out}`);
    assert.equal(JSON.parse(read.out).version, 'atris.feed.v1');
  }
  assert.equal(JSON.parse(reads[0].out).cards[0].id, card.id);
});

test('busy store: still busy after a few seconds, a read says so in JSON with error.busy, and exits 1', async (t) => {
  const { ctx, card, file } = setup(t);
  const holder = await hold(file, 7000);
  const [cards, replies, plain] = await Promise.all([cli(ctx, ['cards', '--json']), cli(ctx, ['replies', card.id, '--json']), cli(ctx, ['cards'])]);
  holder.kill();
  await holder.done;
  for (const read of [cards, replies]) {
    assert.equal(read.status, 1);
    const out = JSON.parse(read.out);
    assert.equal(out.ok, false);
    assert.deepEqual(out.error, { status: 503, message: 'The task list is busy with other work right now. Try again in a moment.', code: 'busy', busy: true });
    assert.ok(read.ms >= feed.READ_BUSY_WAIT_MS - 200 && read.ms < feed.READ_BUSY_WAIT_MS + 3000, `waited ${read.ms} ms`);
  }
  assert.equal(plain.status, 1);
  assert.match(plain.err, /^error: The task list is busy/);
});

test('busy store: a person and a member commenting from separate processes at the same moment both land, whole', async (t) => {
  const { ctx, card } = setup(t);
  const write = (i, as) => new Promise((resolve) => {
    const script = `require(${JSON.stringify(ROOM)}).reply(process.argv[1], process.argv[2], process.argv[3], { as: process.argv[4] || undefined })`;
    const child = spawn(process.execPath, ['-e', script, ctx.root, card.id, `Comment number ${i} from ${as || 'the owner'}.`, as || ''], { env: ctx.env, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (status) => resolve({ status, err }));
  });
  const results = await Promise.all([...Array(12)].map((_, i) => write(i, i % 2 ? 'writer' : '')));
  for (const result of results) assert.equal(result.status, 0, result.err);
  const social = JSON.parse(fs.readFileSync(path.join(ctx.root, '.atris', 'state', 'feed', 'social.json'), 'utf8'));
  assert.equal(social[card.id].replies.length, 12, 'no comment lost');
  assert.equal(new Set(social[card.id].replies.map((r) => r.text)).size, 12);
  assert.deepEqual(fs.readdirSync(path.join(ctx.root, '.atris', 'state', 'feed')).filter((f) => /\.tmp$|\.lock$/.test(f)), [], 'no temp or lock file left');
});

test('busy store: asks counted by separate processes at the same moment all count', async (t) => {
  const { ctx } = setup(t);
  for (const name of ['closer', 'builder', 'editor', 'helper']) {
    fs.mkdirSync(path.join(ctx.root, 'atris', 'team', name), { recursive: true });
    fs.writeFileSync(path.join(ctx.root, 'atris', 'team', name, 'MEMBER.md'), `---\nname: ${name}\nrole: ${name}\n---\n`);
    require('../lib/member-switches').setMemberAwake(name, true, ctx.root);
  }
  // Each process asks one member by name, all at once. Under node --test no thinker really starts.
  const names = ['scout', 'writer', 'closer', 'builder', 'editor', 'helper'];
  const runs = await Promise.all(names.map((name) => cli(ctx, ['ping', name, '--json'])));
  const pinged = runs.reduce((sum, run) => sum + (JSON.parse(run.out).pinged || 0), 0);
  const state = JSON.parse(fs.readFileSync(path.join(ctx.root, '.atris', 'state', 'feed', 'pings.json'), 'utf8'));
  assert.equal(pinged, names.length);
  assert.equal(state.local, pinged, 'every ask counted');
  assert.deepEqual(Object.keys(state.members).sort(), [...names].sort());
});
