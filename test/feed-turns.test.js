'use strict';

// The caller makes the model call; this computer keeps the files. With
// ATRIS_FEED_TURNS=caller a cloud model turn is written to a file and its
// answer read back from one (lib/feed-turns.js). Every answer here is written
// by the test or by `atris feed turns answer`; no model or network is used.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const team = require('../lib/feed-team');
const turns = require('../lib/feed-turns');
const sc = require('../lib/sentinel-cloud');
const { project } = require('./helpers/feed-project');

const BIN = path.join(__dirname, '..', 'bin', 'atris.js');
const SIGNED_OUT = 'This computer is signed out of Atris. Sign it in again.';
const FAST = { id: 'atris-fast', name: 'Atris 2 Fast', kind: 'cloud', model: 'atris:fast', available: true };

// A project on Atris 2 Fast, signed out here, with the switch on and no stand-in turn: the real seam runs.
function callerProject(t, members = ['scout'], extra = {}) {
  const ctx = project(t, members, { engine: 'atris-fast' });
  ctx.env = { ...ctx.env, OBELISK_AUTH_TOKEN: '', ATRIS_TOKEN: '', ATRIS_FEED_TURNS: 'caller', HOME: ctx.dir, ...extra };
  ctx.deps = { ...ctx.deps };
  delete ctx.deps.turn;
  return ctx;
}

function cli(ctx, args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, 'feed', ...args], { cwd: ctx.root, env: ctx.env, encoding: 'utf8' }, (error, stdout, stderr) => {
      resolve({ code: error ? error.code : 0, out: stdout.trim() ? JSON.parse(stdout) : null, stderr });
    });
  });
}

async function nextWaiting(root, ms = 5000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const [first] = turns.listWaiting(root);
    if (first) return first;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return null;
}

const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');

test('turns seam: the request is written in full and the answer comes back as one piece, then both files go', async (t) => {
  const ctx = callerProject(t);
  const pieces = [];
  const running = team.runTurn(FAST, 'Say hello to the owner.', { root: ctx.root, env: ctx.env, member: 'scout', purpose: 'talk', maxOutputTokens: 600, onText: (p) => pieces.push(p) });
  const request = await nextWaiting(ctx.root);
  assert.ok(request, 'a request was written');
  assert.match(request.id, /^[0-9a-f]{16,}$/);
  assert.equal(request.version, 'atris.feed.v1');
  assert.equal(request.member, 'scout');
  assert.equal(request.purpose, 'talk');
  assert.equal(request.model, 'atris:fast');
  assert.equal(request.message, 'Say hello to the owner.');
  assert.equal(request.max_turns, 1);
  assert.equal(request.disable_connector_tools, true);
  assert.deepEqual(request.body, { message: 'Say hello to the owner.', model: 'atris:fast', max_turns: 1, disable_connector_tools: true, max_output_tokens: 600 });
  assert.ok(Date.parse(request.expires_at) > Date.parse(request.created_at));
  assert.deepEqual(turns.command(ctx.root, ['answer', request.id], { 'append-b64': b64('Hello there.') }).out, { ok: true, chars: 12 });
  assert.deepEqual(turns.command(ctx.root, ['answer', request.id], { done: true }).out, { ok: true });
  const out = await running;
  assert.equal(out.ok, true);
  assert.equal(out.text, 'Hello there.');
  assert.deepEqual(pieces, ['Hello there.']);
  assert.deepEqual(fs.readdirSync(turns.turnsDir(ctx.root)).filter((n) => !n.startsWith('live')), [], 'request and answer removed');
});

test('turns seam: same return as the network call for a failure, a sign-in failure and an empty answer', async () => {
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'feed-turns-'));
  try {
    const env = { ATRIS_FEED_TURNS: 'caller' };
    const answer = async (write) => {
      const running = turns.runCallerTurn({ model: 'atris:fast', prompt: 'hi', root, env });
      const request = await nextWaiting(root);
      write(request.id);
      return running;
    };
    const failed = await answer((id) => turns.command(root, ['answer', id], { failed: 'Atris 2 Fast is busy right now.' }));
    assert.deepEqual(failed, { ok: false, stdout: '', reason: 'Atris 2 Fast is busy right now.', credits_charged: 0, billed: false });
    const signIn = await answer((id) => turns.command(root, ['answer', id], { failed: 'The website is signed out.', 'needs-sign-in': true }));
    assert.equal(signIn.ok, false);
    assert.equal(sc.isSignInFailure(signIn.reason), true);
    const empty = await answer((id) => turns.command(root, ['answer', id], { done: true }));
    assert.deepEqual(empty, { ok: false, stdout: '', reason: 'empty answer', credits_charged: 0, billed: false });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('turns seam: no answer in time says the model took too long, removes the request and gives the ask back', async (t) => {
  const ctx = callerProject(t, ['scout'], { ATRIS_FEED_TURN_WAIT_MS: '300' });
  const events = [];
  const out = await team.pingStream(ctx.root, { reason: 'more', env: ctx.env, deps: ctx.deps, onEvent: (e) => events.push(e) });
  const row = out.members.find((m) => m.name === 'scout');
  assert.equal(row.error, 'Atris 2 Fast took too long to answer. Ask again in a moment.');
  assert.equal(row.needs_sign_in, undefined);
  assert.deepEqual(turns.listWaiting(ctx.root), []);
  assert.deepEqual(fs.readdirSync(turns.turnsDir(ctx.root)).filter((n) => /\.json$|\.partial$/.test(n)), []);
  const pings = JSON.parse(fs.readFileSync(path.join(ctx.root, '.atris', 'state', 'feed', 'pings.json'), 'utf8'));
  assert.equal(Number(pings.cloud) || 0, 0, 'the ask it used was given back');
});

test('turns seam: a sign-in failure from the caller reads as signed out on the thought, with the ask given back', async (t) => {
  const ctx = callerProject(t);
  const running = team.pingStream(ctx.root, { reason: 'more', env: ctx.env, deps: ctx.deps, onEvent: () => {} });
  const request = await nextWaiting(ctx.root);
  turns.command(ctx.root, ['answer', request.id], { failed: 'The website is signed out.', 'needs-sign-in': true });
  const out = await running;
  const row = out.members.find((m) => m.name === 'scout');
  assert.equal(row.error, SIGNED_OUT);
  assert.equal(row.needs_sign_in, true);
  const pings = JSON.parse(fs.readFileSync(path.join(ctx.root, '.atris', 'state', 'feed', 'pings.json'), 'utf8'));
  assert.equal(Number(pings.cloud) || 0, 0, 'the ask it used was given back');
});

test('turns: a full thinking round under the switch makes a real card from an answer written by the turns commands', async (t) => {
  const ctx = callerProject(t);
  const events = [];
  let answered = 0;
  let stop = false;
  // The caller: lists waiting turns, reads one, answers it in two pieces, then done. All through the command line.
  const caller = (async () => {
    while (!stop) {
      const list = await cli(ctx, ['turns', '--json']);
      const turn = list.out && list.out.turns[0];
      if (!turn) { await new Promise((resolve) => setTimeout(resolve, 50)); continue; }
      assert.equal(list.out.thinking, true);
      assert.equal(turn.member, 'scout');
      assert.equal(turn.purpose, 'think');
      assert.equal(turn.model, 'atris:fast');
      assert.equal(turn.message, undefined, 'no message text in the list');
      assert.ok(turn.message_chars > 100);
      const shown = await cli(ctx, ['turns', 'show', turn.id, '--json']);
      assert.match(shown.out.message, /thinking up ideas for the owner's feed/);
      const text = 'IDEA\nTITLE: Thank the first ten buyers\nWHY: Thanked buyers come back\nEND\n';
      assert.equal((await cli(ctx, ['turns', 'answer', turn.id, '--append-b64', b64(text.slice(0, 20))])).out.chars, 20);
      assert.equal((await cli(ctx, ['turns', 'answer', turn.id, '--append-b64', b64(text.slice(20))])).out.chars, text.length);
      assert.deepEqual((await cli(ctx, ['turns', 'answer', turn.id, '--done'])).out, { ok: true });
      answered += 1;
    }
  })();
  try {
    await team.pingStream(ctx.root, { reason: 'more', env: ctx.env, deps: ctx.deps, onEvent: (e) => events.push(e) });
  } finally {
    stop = true;
    await caller;
  }
  assert.ok(answered >= 1);
  const card = events.find((e) => e.type === 'card_done');
  assert.ok(card, `a card was made: ${JSON.stringify(events.map((e) => e.type))}`);
  assert.equal(card.card.title, 'Thank the first ten buyers');
  const after = await cli(ctx, ['turns', '--json']);
  assert.deepEqual(after.out, { version: 'atris.feed.v1', turns: [], thinking: false });
});

test('turns: chunked appends then done equal the whole text, including words in other scripts', () => {
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'feed-turns-'));
  try {
    const id = 'a'.repeat(24);
    const now = Date.now();
    fs.mkdirSync(turns.turnsDir(root), { recursive: true });
    fs.writeFileSync(path.join(turns.turnsDir(root), `${id}.json`), JSON.stringify({ version: 'atris.feed.v1', id, created_at: new Date(now).toISOString(), expires_at: new Date(now + 60000).toISOString(), member: null, purpose: 'other', model: 'atris:fast', message: 'x', max_turns: 1, disable_connector_tools: true }));
    const whole = 'Café ☕ and 東京, then a long line.\nSecond line.';
    let chars = 0;
    for (const piece of whole.match(/[\s\S]{1,5}/g)) chars = turns.command(root, ['answer', id], { 'append-b64': b64(piece) }).out.chars;
    assert.equal(chars, whole.length);
    turns.command(root, ['answer', id], { done: true });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(turns.turnsDir(root), `${id}.answer.json`), 'utf8')), { ok: true, text: whole });
    assert.deepEqual(turns.command(root, ['answer', id], { done: true }).out, { error: 'That turn is not waiting.' }, 'an answered turn takes no more');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('turns: the Atris models are available under the switch whatever the sign-in here, and signed out without it', (t) => {
  const ctx = callerProject(t, ['scout'], { ATRIS_FEED_INSTALLED: '' });
  const cloud = team.listEngines({ env: ctx.env }).filter((e) => e.kind === 'cloud' && e.id !== 'atris-agent-1');
  assert.deepEqual(cloud.map((e) => [e.id, e.available, e.reason, e.needs_sign_in]), [
    ['atris-fast', true, null, undefined], ['atris-pro', true, null, undefined], ['atris-max', true, null, undefined],
  ]);
  fs.writeFileSync(path.join(ctx.root, 'atris', '.config'), JSON.stringify({}));
  const settings = team.settingsView(ctx.root, { env: ctx.env });
  assert.equal(settings.engine_in_effect, 'atris-fast', 'the house pick lands on Atris 2 Fast');
  assert.equal(settings.engine_available, true);
  assert.equal(team.listMembers(ctx.root, { env: ctx.env }).members[0].engine_available, true);
  const plan = team.ping(ctx.root, { reason: 'more', env: ctx.env, deps: ctx.deps });
  assert.equal(plan.pinged, 1);
  assert.equal(plan.needs_sign_in, undefined);
  for (const off of [undefined, 'Caller', 'yes', '']) {
    const env = { ...ctx.env, ATRIS_FEED_TURNS: off };
    if (off === undefined) delete env.ATRIS_FEED_TURNS;
    const fast = team.listEngines({ env }).find((e) => e.id === 'atris-fast');
    assert.equal(fast.available, false, String(off));
    assert.equal(fast.reason, SIGNED_OUT, String(off));
    assert.equal(fast.needs_sign_in, true, String(off));
  }
});

test('turns: list, show and answer refuse unknown, expired and badly named turns, and list shows no message text', async (t) => {
  const ctx = callerProject(t);
  const dir = turns.turnsDir(ctx.root);
  fs.mkdirSync(dir, { recursive: true });
  const now = Date.now();
  const write = (id, ageMs, expiresInMs) => fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({
    version: 'atris.feed.v1', id, created_at: new Date(now - ageMs).toISOString(), expires_at: new Date(now + expiresInMs).toISOString(),
    member: 'scout', purpose: 'think', model: 'atris:pro', message: 'secret words', max_turns: 1, disable_connector_tools: true,
  }));
  const older = '1'.repeat(16);
  const newer = 'b'.repeat(20);
  const gone = 'c'.repeat(16);
  write(newer, 1000, 60000);
  write(older, 5000, 60000);
  write(gone, 100000, -1);
  const list = await cli(ctx, ['turns', '--json']);
  assert.equal(list.code, 0);
  assert.deepEqual(list.out.turns.map((r) => r.id), [older, newer], 'oldest first, the expired one left out');
  assert.equal(list.out.turns[0].message_chars, 'secret words'.length);
  assert.ok(list.out.turns[0].age_ms >= 5000);
  assert.deepEqual(Object.keys(list.out.turns[0]).sort(), ['age_ms', 'id', 'max_turns', 'member', 'message_chars', 'model', 'purpose']);
  assert.doesNotMatch(JSON.stringify(list.out), /secret words/);
  assert.equal(list.out.thinking, true, 'turns are waiting');
  assert.equal(fs.existsSync(path.join(dir, `${gone}.json`)), false, 'the expired request was cleaned up');
  const shown = await cli(ctx, ['turns', 'show', older, '--json']);
  assert.equal(shown.out.message, 'secret words');
  for (const bad of [gone, 'ABCDEF0123456789', '../../../etc/passwd', 'abc', `${older}.json`, 'f'.repeat(16)]) {
    for (const args of [['show', bad, '--json'], ['answer', bad, '--done'], ['answer', bad, '--append-b64', b64('x')], ['answer', bad, '--failed', 'No.']]) {
      const run = await cli(ctx, ['turns', ...args]);
      assert.equal(run.code, 1, `${bad} ${args[0]}`);
      assert.deepEqual(run.out, { error: 'That turn is not waiting.' });
    }
  }
  const failed = await cli(ctx, ['turns', 'answer', newer, '--failed', 'The website could not reach the model.', '--needs-sign-in']);
  assert.deepEqual(failed.out, { ok: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, `${newer}.answer.json`), 'utf8')), { ok: false, reason: 'The website could not reach the model.', needs_sign_in: true });
});

test('turns: thinking is true while a background teammate process started under the switch is alive, false once it is gone', (t) => {
  const ctx = callerProject(t);
  assert.equal(turns.thinking(ctx.root), false);
  turns.noteLive(ctx.root, process.pid, 'think', ctx.env);
  assert.equal(turns.thinking(ctx.root), true);
  assert.equal(turns.thinking(ctx.root, { alive: () => false }), false);
  assert.deepEqual(fs.readdirSync(path.join(turns.turnsDir(ctx.root), 'live')), [], 'the mark of a gone process is cleaned');
  turns.noteLive(ctx.root, process.pid, 'think', { ...ctx.env, ATRIS_FEED_TURNS: 'no' });
  assert.equal(turns.thinking(ctx.root), false, 'nothing is marked without the switch');
});

test('turns: without the switch a cloud turn goes to the network call as before and writes no file', async (t) => {
  const ctx = callerProject(t);
  const original = sc.runAtrisTurn;
  const calls = [];
  sc.runAtrisTurn = async (args) => { calls.push(args); args.onText('ok'); return { ok: true, stdout: 'ok', credits_charged: 2, billed: true }; };
  t.after(() => { sc.runAtrisTurn = original; });
  for (const off of [undefined, 'Caller', '1']) {
    const env = { ...ctx.env, ATRIS_FEED_TURNS: off };
    if (off === undefined) delete env.ATRIS_FEED_TURNS;
    const out = await team.runTurn(FAST, 'hi', { root: ctx.root, env, member: 'scout', purpose: 'talk' });
    assert.equal(out.ok, true);
    assert.equal(out.credits_charged, 2);
  }
  assert.equal(calls.length, 3);
  assert.equal(fs.existsSync(turns.turnsDir(ctx.root)), false);
});
