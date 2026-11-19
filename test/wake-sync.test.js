'use strict';

// One switch per team member: `atris feed member on|off` also sets the cloud
// note-wake switch, `atris tell wake` also flips the local feed switch, and
// `atris feed members` marks a member whose two switches disagree. Every
// member, server and token here is a stand-in.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { run } = require('../commands/decision-feed');
const { tellCommand } = require('../commands/tell');
const team = require('../lib/feed-team');
const { project } = require('./helpers/feed-project');

const BIZ = '5db129d0-aa32-46eb-81ae-29bb86f67b0f';
const TOKEN = 'secret-tok-wake-sync';

// The feed's own view: on only when the switch is set on.
function isOn(root, name) {
  return team.listMembers(root, {}).members.find((m) => m.name === name).on;
}

function bind(root) {
  fs.mkdirSync(path.join(root, '.atris'), { recursive: true });
  fs.writeFileSync(path.join(root, '.atris', 'business.json'), JSON.stringify({ business_id: BIZ, slug: 'atris-labs', name: 'Atris Labs' }));
}

function server(routes = {}) {
  const calls = [];
  const api = async (pathname, options = {}) => {
    const key = `${options.method || 'GET'} ${pathname}`;
    calls.push({ key, body: options.body, timeoutMs: options.timeoutMs, retries: options.retries });
    if (routes[key]) return routes[key](options);
    return { ok: false, status: 404, data: { detail: 'Not Found' } };
  };
  return { api, calls };
}

const PATCH = (name) => `PATCH /business/${BIZ}/team/${name}`;
const SWITCHES = `GET /swarlo/${BIZ}/wake-switches`;
const saved = (o) => ({ ok: true, status: 200, data: { updated: { wake_on_mention: o.body.wake_on_mention } } });

async function feed(args, ctx, deps) {
  const out = [];
  const errs = [];
  const log = console.log;
  const error = console.error;
  console.log = (l) => out.push(String(l));
  console.error = (l) => errs.push(String(l));
  try {
    const code = await run(args, { cwd: ctx.root, env: ctx.env, deps: { ...ctx.deps, ...deps } });
    return { code, out, errs };
  } finally {
    console.log = log;
    console.error = error;
  }
}

// ── atris feed member on|off ────────────────────────────────

test('feed member off also turns off waking in the cloud for a business project', async (t) => {
  const ctx = project(t, ['scout', 'writer']);
  bind(ctx.root);
  const s = server({ [PATCH('scout')]: saved });
  const r = await feed(['member', 'off', 'scout', '--json'], ctx, { apiRequestJson: s.api, token: TOKEN });
  assert.equal(r.code, 0, r.errs.join('\n'));
  assert.equal(isOn(ctx.root, 'scout'), false);
  const call = s.calls.find((c) => c.key === PATCH('scout'));
  assert.deepEqual(call.body, { wake_on_mention: false });
  assert.equal(call.retries, 0);
  assert.equal(JSON.parse(r.out.join('\n')).cloud.status, 'set');
});

test('a failed cloud call prints one plain line and the local switch still flips', async (t) => {
  const ctx = project(t, ['scout'], { on: false });
  bind(ctx.root);
  const s = server({ [PATCH('scout')]: () => ({ ok: false, status: 500, data: { detail: 'boom' } }) });
  const r = await feed(['member', 'on', 'scout'], ctx, { apiRequestJson: s.api, token: TOKEN });
  assert.equal(r.code, 0, r.errs.join('\n'));
  assert.equal(isOn(ctx.root, 'scout'), true);
  assert.equal(r.out.filter((l) => /did not change/.test(l)).length, 1);
  assert.match(r.out.at(-1), /^Waking on notes in atris-labs did not change for scout\. Try: atris tell wake scout on$/);

  const thrown = server({ [PATCH('scout')]: () => { throw new Error('offline'); } });
  const again = await feed(['member', 'off', 'scout'], ctx, { apiRequestJson: thrown.api, token: TOKEN });
  assert.equal(again.code, 0);
  assert.equal(isOn(ctx.root, 'scout'), false);
  assert.match(again.out.at(-1), /did not change for scout/);
});

test('a member only on this computer, or a folder that is no business, never calls or warns', async (t) => {
  const ctx = project(t, ['scout']);
  bind(ctx.root);
  const s = server({ [PATCH('scout')]: () => ({ ok: false, status: 404, data: { detail: 'Agent not found' } }) });
  const r = await feed(['member', 'off', 'scout'], ctx, { apiRequestJson: s.api, token: TOKEN });
  assert.equal(r.code, 0);
  assert.ok(!r.out.some((l) => /did not change/.test(l)));

  const plain = project(t, ['scout']);
  const none = server();
  const p = await feed(['member', 'off', 'scout'], plain, { apiRequestJson: none.api, token: TOKEN });
  assert.equal(p.code, 0);
  assert.equal(none.calls.length, 0);
  assert.equal(isOn(plain.root, 'scout'), false);
});

test('a refused local switch never touches the cloud', async (t) => {
  const ctx = project(t, ['scout']);
  bind(ctx.root);
  const s = server({ [PATCH('scout')]: saved });
  const r = await feed(['member', 'off', 'scout'], { ...ctx, env: ctx.agentEnv }, { apiRequestJson: s.api, token: TOKEN });
  assert.equal(r.code, 1);
  assert.equal(s.calls.length, 0);
});

// ── atris feed members ──────────────────────────────────────

test('feed members marks a member whose cloud switch disagrees', async (t) => {
  const ctx = project(t, ['scout', 'writer', 'closer']);
  bind(ctx.root);
  const s = server({
    [SWITCHES]: () => ({ ok: true, status: 200, data: { members: [
      { slug: 'scout', name: 'Scout', wake_on_mention: true },
      { slug: 'writer', name: 'Writer', wake_on_mention: false },
    ] } }),
  });
  const json = await feed(['members', '--json'], ctx, { apiRequestJson: s.api, token: TOKEN });
  const rows = Object.fromEntries(JSON.parse(json.out.join('\n')).members.map((m) => [m.name, [m.on, m.cloud_on, m.switch_mismatch]]));
  assert.deepEqual(rows, { scout: [true, true, false], writer: [true, false, true], closer: [true, null, false] });

  const text = await feed(['members'], ctx, { apiRequestJson: s.api, token: TOKEN });
  assert.match(text.out.find((l) => /writer/.test(l)), /\[cloud off\]$/);
  assert.ok(!/\[cloud/.test(text.out.find((l) => /scout/.test(l))));
  assert.ok(!/\[cloud/.test(text.out.find((l) => /closer/.test(l))));
});

test('feed members still lists everyone when the cloud does not answer', async (t) => {
  const ctx = project(t, ['scout']);
  bind(ctx.root);
  const s = server({ [SWITCHES]: () => { throw new Error('offline'); } });
  const r = await feed(['members', '--json'], ctx, { apiRequestJson: s.api, token: TOKEN });
  assert.equal(r.code, 0);
  const [m] = JSON.parse(r.out.join('\n')).members;
  assert.deepEqual([m.name, m.on, m.cloud_on, m.switch_mismatch], ['scout', true, null, false]);
});

// ── atris tell wake ─────────────────────────────────────────

function tellDeps(ctx, api, env = ctx.env) {
  const stdout = [];
  const stderr = [];
  return {
    stdout,
    stderr,
    deps: {
      token: TOKEN,
      ensureCredentials: async () => ({ error: 'none' }),
      env: { ...env, ATRIS_BUSINESS: '' },
      cwd: ctx.root,
      homeDir: ctx.dir,
      apiRequestJson: api,
      log: (l) => stdout.push(String(l)),
      err: (l) => stderr.push(String(l)),
    },
  };
}

test('tell wake inside the business folder also flips the local feed switch', async (t) => {
  const ctx = project(t, ['scout'], { on: false });
  bind(ctx.root);
  const s = server({ [PATCH('scout')]: saved, [PATCH('Scout')]: saved });
  const h = tellDeps(ctx, s.api);
  assert.equal(await tellCommand(['wake', 'scout', 'on'], h.deps), 0, h.stderr.join('\n'));
  assert.equal(isOn(ctx.root, 'scout'), true);
  assert.deepEqual(h.stderr, []);
  assert.equal(await tellCommand(['wake', 'Scout', 'off'], h.deps), 0, h.stderr.join('\n'));
  assert.equal(isOn(ctx.root, 'scout'), false);
});

test('tell wake for another business, or a member not on this team, leaves the local switch alone', async (t) => {
  const ctx = project(t, ['scout'], { on: false });
  fs.mkdirSync(path.join(ctx.root, '.atris'), { recursive: true });
  fs.writeFileSync(path.join(ctx.root, '.atris', 'business.json'), JSON.stringify({ business_id: 'other-business', slug: 'other' }));
  const s = server({ [`PATCH /business/${BIZ}/team/scout`]: saved, [PATCH('nova')]: saved });
  const h = tellDeps(ctx, s.api);
  h.deps.env.ATRIS_BUSINESS = BIZ;
  assert.equal(await tellCommand(['wake', 'scout', 'on', '--business', BIZ], h.deps), 0, h.stderr.join('\n'));
  assert.equal(isOn(ctx.root, 'scout'), false);

  bind(ctx.root);
  assert.equal(await tellCommand(['wake', 'nova', 'on'], h.deps), 0, h.stderr.join('\n'));
  assert.deepEqual(h.stderr, []);
});

test('a local switch that refuses prints one plain line and the cloud change stands', async (t) => {
  const ctx = project(t, ['scout']);
  bind(ctx.root);
  const s = server({ [PATCH('scout')]: saved });
  const h = tellDeps(ctx, s.api, ctx.agentEnv);
  assert.equal(await tellCommand(['wake', 'scout', 'off'], h.deps), 0);
  assert.equal(isOn(ctx.root, 'scout'), true);
  assert.equal(h.stderr.length, 1);
  assert.match(h.stderr[0], /^The feed switch for scout here did not change: Only a person can turn a team member on or off/);
});
