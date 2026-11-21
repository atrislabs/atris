'use strict';

// The feed tells the truth about the Atris sign-in: a missing, expired or
// scoped pass is signed out everywhere a screen reads, a signed-out ask spends
// nothing, and a teammate whose turn failed says why instead of "had nothing".
// Every turn here is a stand-in; no model is ever called.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const feed = require('../lib/feed-core');
const team = require('../lib/feed-team');
const sc = require('../lib/sentinel-cloud');
const { project } = require('./helpers/feed-project');

const SIGNED_OUT = 'This computer is signed out of Atris. Sign it in again.';
const HOUR = 3600;

function pass(claims) {
  const part = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'HS256', typ: 'JWT' })}.${part(claims)}.signature`;
}
const now = () => Math.floor(Date.now() / 1000);
const GOOD = pass({ sub: 'u1', exp: now() + HOUR });
const EXPIRED = pass({ sub: 'u1', exp: now() - 60 * 24 * HOUR });
// What the live cloud computer held: a scoped pass for reading mail only (it had also expired).
const SCOPED = pass({ sub: 'u1', type: 'agent_access', scopes: ['gmail-read'], exp: now() + HOUR });

function logText(ctx, member) {
  const dir = path.join(ctx.root, 'atris', 'team', member, 'logs');
  if (!fs.existsSync(dir)) return '';
  return fs.readdirSync(dir).map((name) => fs.readFileSync(path.join(dir, name), 'utf8')).join('\n');
}

function cloudPings(ctx) {
  const file = path.join(ctx.root, '.atris', 'state', 'feed', 'pings.json');
  return fs.existsSync(file) ? Number(JSON.parse(fs.readFileSync(file, 'utf8')).cloud) || 0 : 0;
}

function cloudProject(t, token, members = ['scout']) {
  const ctx = project(t, members, { engine: 'atris-fast' });
  ctx.env = { ...ctx.env, OBELISK_AUTH_TOKEN: token };
  return ctx;
}

test('sign-in: no token, an expired pass and a scoped pass are signed out; a good or unreadable pass is not', () => {
  const fast = (token) => team.listEngines({ isInstalled: () => false, authToken: () => token }).find((e) => e.id === 'atris-fast');
  for (const [label, token] of [['no token', ''], ['expired pass', EXPIRED], ['scoped pass', SCOPED]]) {
    const engine = fast(token);
    assert.equal(engine.available, false, label);
    assert.equal(engine.reason, SIGNED_OUT, label);
    assert.equal(engine.needs_sign_in, true, label);
  }
  for (const [label, token] of [
    ['good pass', GOOD],
    ['a token that is not a readable pass', 'atris_key_0123456789'],
    ['a scoped pass that can act as its own account', pass({ type: 'agent_access', scopes: ['account'], exp: now() + HOUR })],
    ['a scoped pass with a scope this computer does not know', pass({ type: 'agent_access', scopes: ['gmail-read', 'something-new'], exp: now() + HOUR })],
    ['a scoped pass with no scope list', pass({ type: 'agent_access', exp: now() + HOUR })],
  ]) {
    const engine = fast(token);
    assert.equal(engine.available, true, label);
    assert.equal(engine.reason, null, label);
  }
  assert.deepEqual(sc.modelSignIn(SCOPED), { signed_in: false, why: 'scoped' });
  assert.deepEqual(sc.modelSignIn(EXPIRED), { signed_in: false, why: 'expired' });
  assert.deepEqual(sc.modelSignIn(''), { signed_in: false, why: 'no_token' });
});

test('sign-in: settings, members and engines all say the one sentence when the computer is signed out', (t) => {
  const ctx = cloudProject(t, SCOPED);
  const settings = team.settingsView(ctx.root, { env: ctx.env });
  assert.equal(settings.engine_in_effect, 'atris-fast');
  assert.equal(settings.engine_available, false);
  assert.equal(settings.engine_reason, SIGNED_OUT);
  const members = team.listMembers(ctx.root, { env: ctx.env });
  assert.equal(members.members[0].engine_available, false);
  assert.ok(team.listEngines({ env: ctx.env }).filter((e) => e.kind === 'cloud' && e.id !== 'atris-agent-1').every((e) => e.reason === SIGNED_OUT));
  const signedIn = team.settingsView(ctx.root, { env: { ...ctx.env, OBELISK_AUTH_TOKEN: GOOD } });
  assert.equal(signedIn.engine_available, true);
  assert.equal(signedIn.engine_reason, null);
});

test('sign-in: a ping while signed out skips every member with the sentence and uses no ask of the day', async (t) => {
  const ctx = cloudProject(t, EXPIRED, ['scout', 'writer']);
  const out = team.ping(ctx.root, { reason: 'refresh', env: ctx.env, deps: ctx.deps });
  assert.equal(out.pinged, 0);
  assert.equal(out.reason, SIGNED_OUT);
  assert.equal(out.needs_sign_in, true);
  assert.deepEqual(out.members.map((m) => [m.name, m.status, m.reason]).sort(), [['scout', 'skipped', SIGNED_OUT], ['writer', 'skipped', SIGNED_OUT]]);
  const more = feed.requestMoreIdeas(ctx.root, { env: ctx.env, deps: ctx.deps });
  assert.equal(more.requested, 0);
  assert.equal(more.reason, SIGNED_OUT);
  const events = [];
  const streamed = await team.pingStream(ctx.root, { reason: 'refresh', env: ctx.env, deps: ctx.deps, onEvent: (event) => events.push(event) });
  assert.equal(streamed.reason, SIGNED_OUT);
  assert.ok(events.filter((e) => e.type === 'member_skipped').every((e) => e.reason === SIGNED_OUT && e.needs_sign_in === true));
  assert.equal(ctx.turns.length, 0, 'no model was called');
  assert.equal(ctx.thinkers.length, 0, 'nothing started thinking');
  assert.equal(cloudPings(ctx), 0, 'no ask of the day was used');
  assert.equal(team.settingsView(ctx.root, { env: ctx.env }).today.cloud_pings, 0);
});

test('sign-in: atris feed ping --json gives a screen the sentence at once', (t) => {
  const ctx = cloudProject(t, SCOPED);
  const { spawnSync } = require('node:child_process');
  const run = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'atris.js'), 'feed', 'ping', '--json'], {
    cwd: ctx.root, env: { ...ctx.env, HOME: ctx.dir }, encoding: 'utf8',
  });
  assert.equal(run.status, 0, run.stderr);
  const out = JSON.parse(run.stdout);
  assert.deepEqual(out, {
    version: out.version,
    pinged: 0,
    reason: SIGNED_OUT,
    needs_sign_in: true,
    members: [{ name: 'scout', status: 'skipped', reason: SIGNED_OUT, needs_sign_in: true }],
  });
});

test('a failed thought says why: "Could not think", a failed event, an error to read, and the ask given back', async (t) => {
  const ctx = cloudProject(t, GOOD);
  const deps = { ...ctx.deps, turn: async ({ engine }) => { ctx.turns.push({ engine: engine.id }); return { ok: false, error: 'the server said 401: Agent token revoked or expired' }; } };
  const events = [];
  // A tap for more: the person asked, so a teammate on an Atris model is woken (the feed asking by itself never would).
  const out = await team.pingStream(ctx.root, { reason: 'more', env: ctx.env, deps, onEvent: (event) => events.push(event) });
  assert.equal(ctx.turns.length, 1, 'a failed turn is not tried again for different ideas');
  const row = out.members.find((m) => m.name === 'scout');
  assert.equal(row.error, SIGNED_OUT);
  assert.equal(row.needs_sign_in, true);
  const done = events.find((e) => e.type === 'member_done');
  assert.equal(done.error, SIGNED_OUT);
  assert.equal(done.needs_sign_in, true);
  const log = logText(ctx, 'scout');
  assert.match(log, /Could not think: This computer is signed out of Atris\. Sign it in again\./);
  assert.doesNotMatch(log, /nothing worth your time/);
  const failed = team.readEvents(ctx.root).filter((e) => e.type === 'failed');
  assert.equal(failed.length, 1);
  assert.equal(failed[0].member, 'scout');
  assert.equal(failed[0].text, `Could not think: ${SIGNED_OUT}`);
  assert.equal(cloudPings(ctx), 0, 'the ask it used was given back');
});

test('a failed thought on another fault says it plainly, with no status code', async (t) => {
  const ctx = cloudProject(t, GOOD);
  for (const [error, said] of [
    ['the server said 500: Internal Server Error', /^Atris 2 Fast had a problem on its side\. Try again in a moment\.$/],
    ['getaddrinfo ENOTFOUND api.atris.ai', /^Atris 2 Fast could not be reached\./],
    ['empty answer', /^Atris 2 Fast gave no answer\. Ask again in a moment\.$/],
  ]) {
    const deps = { ...ctx.deps, sleep: async () => {}, turn: async () => ({ ok: false, error }) };
    const out = await team.pingStream(ctx.root, { reason: 'more', env: ctx.env, deps });
    const row = out.members.find((m) => m.name === 'scout');
    assert.match(row.error, said, error);
    assert.doesNotMatch(row.error, /\b\d{3}\b|ENOTFOUND/, error);
    assert.equal(row.needs_sign_in, undefined, error);
  }
  assert.doesNotMatch(logText(ctx, 'scout'), /nothing worth your time/);
  assert.equal(cloudPings(ctx), 0);
});

test('a queued ping whose turn failed says "Could not think", never "Woke and had nothing"', async (t) => {
  const ctx = project(t, ['scout']);
  const deps = { ...ctx.deps, turn: async () => ({ ok: false, error: 'timed out' }) };
  const done = await team.runPing(ctx.root, { member: 'scout', reason: 'event' }, deps);
  assert.equal(done.ok, false);
  assert.match(done.error, /^Codex( \([^)]*\))? took too long to answer\./);
  const log = logText(ctx, 'scout');
  assert.match(log, /Could not think: Codex( \([^)]*\))? took too long to answer\./);
  assert.doesNotMatch(log, /nothing worth your time/);
  assert.equal(team.readEvents(ctx.root).filter((e) => e.type === 'failed').length, 1);
});

test('models: Atris 2 Fast, Pro and Max are listed by name and can be the default or one member\'s model', (t) => {
  const ctx = project(t, ['scout'], { engine: null });
  const options = { env: ctx.env, authToken: () => GOOD };
  const cloud = team.listEngines(options).filter((e) => e.kind === 'cloud');
  assert.deepEqual(cloud.map((e) => [e.id, e.name, e.model, e.available]), [
    ['atris-fast', 'Atris 2 Fast', 'atris:fast', true],
    ['atris-pro', 'Atris 2 Pro', 'atris:pro', true],
    ['atris-max', 'Atris 2 Max', 'atris:max', true],
    ['atris-agent-1', 'Atris agent-1', 'agent-1', false],
  ]);
  for (const id of ['atris-fast', 'atris-pro', 'atris-max']) {
    assert.equal(team.COSTLY.has(id), false, `${id} runs in the feed like atris-fast`);
    const out = team.setDefaultEngine(ctx.root, id, options);
    assert.equal(out.default_engine, id);
    assert.equal(out.engine_available, true);
    assert.equal(team.memberEngine(ctx.root, 'scout', options).name, cloud.find((e) => e.id === id).name);
  }
  team.setMemberEngine(ctx.root, 'scout', 'atris-pro', options);
  assert.equal(team.memberEngine(ctx.root, 'scout', options).id, 'atris-pro');
  assert.throws(() => team.setDefaultEngine(ctx.root, 'atris-max', { env: ctx.env, authToken: () => SCOPED }),
    (e) => e.status === 409 && e.message.includes(SIGNED_OUT), 'a signed-out model is refused, never saved');
});
