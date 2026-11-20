'use strict';

// Feed model turns: a project bound to a business asks that business to pay,
// and an ordinary login near its end is renewed before the turn. A placed
// computer pass (agent-token.json) is used as is. Every server and sign-in
// here is a stand-in; nothing reaches the backend or a model.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const cloud = require('../lib/sentinel-cloud');
const realAuth = require('../utils/auth');

const made = [];
test.after(() => { for (const dir of made) fs.rmSync(dir, { recursive: true, force: true }); });

function tmpProject(business) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-feed-payer-'));
  made.push(root);
  if (business !== undefined) {
    fs.mkdirSync(path.join(root, '.atris'), { recursive: true });
    fs.writeFileSync(path.join(root, '.atris', 'business.json'), typeof business === 'string' ? business : JSON.stringify(business));
  }
  return root;
}

function jwtWith(claims) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc(claims)}.sig`;
}

const nowSec = () => Math.floor(Date.now() / 1000);

async function turnBodies(runs) {
  const bodies = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      bodies.push({ path: req.url, auth: req.headers.authorization, body: JSON.parse(raw) });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify({ type: 'result', result: 'ok' })}\n\n`);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const run of runs) await run(base);
  } finally {
    server.close();
  }
  return bodies;
}

// ------------------------------------------------------------ who pays

test('a turn names the business when one is given, and only then', async () => {
  const bodies = await turnBodies([
    (base) => cloud.runAtrisTurn({ model: 'atris:fast', prompt: 'hi', token: 't', base, businessId: 'biz-1' }),
    (base) => cloud.runAtrisTurn({ model: 'atris:fast', prompt: 'hi', token: 't', base }),
    (base) => cloud.runAtrisTurn({ model: 'atris:fast', prompt: 'hi', token: 't', base, businessId: '  ' }),
  ]);
  assert.equal(bodies[0].path, '/atris2/turn');
  assert.equal(bodies[0].body.business_id, 'biz-1');
  assert.equal('business_id' in bodies[1].body, false);
  assert.equal('business_id' in bodies[2].body, false);
});

test('the project business comes from .atris/business.json and is absent without it', () => {
  assert.equal(cloud.projectBusinessId(tmpProject()), null);
  assert.equal(cloud.projectBusinessId(tmpProject({ business_id: 'biz-uuid', slug: 'acme' })), 'biz-uuid');
  assert.equal(cloud.projectBusinessId(tmpProject({ slug: 'acme' })), 'acme');
  assert.equal(cloud.projectBusinessId(tmpProject('not json')), null);
  assert.equal(cloud.projectBusinessId(tmpProject({ business_id: 42 })), null);
  assert.equal(cloud.projectBusinessId(null), null);
});

test('a cloud feed turn sends the project business, and none for a project without one', async (t) => {
  const team = require('../lib/feed-team');
  const seen = [];
  t.mock.method(cloud, 'freshAuthToken', async () => 'signed-in');
  t.mock.method(cloud, 'runAtrisTurn', async (args) => { seen.push(args); return { ok: true, stdout: 'done', credits_charged: 1 }; });
  const engine = { kind: 'cloud', id: 'atris-fast', model: 'atris:fast' };
  const bound = await team.runTurn(engine, 'think', { root: tmpProject({ business_id: 'biz-uuid' }), env: {} });
  const loose = await team.runTurn(engine, 'think', { root: tmpProject(), env: {} });
  assert.equal(bound.ok, true);
  assert.equal(loose.ok, true);
  assert.equal(seen[0].businessId, 'biz-uuid');
  assert.equal(seen[0].token, 'signed-in');
  assert.equal(seen[1].businessId, null);
});

// ------------------------------------------------------------ renewing the sign-in

function fakeAuth(creds, refresh) {
  const calls = [];
  return {
    calls,
    auth: {
      ...realAuth,
      loadCredentials: () => creds,
      performTokenRefresh: async (c, api, opts) => {
        calls.push({ c, opts });
        return refresh(c);
      },
    },
  };
}

const renewedTo = (token) => async () => ({ ok: true, payload: { credentials: { token } } });

test('a placed computer pass is used as is, never renewed', async () => {
  const placed = jwtWith({ sub: 'biz', atris_service: 'computer', exp: nowSec() + 60 });
  const { auth, calls } = fakeAuth({ token: placed, expires_at: new Date(Date.now() + 60000).toISOString(), source: 'agent_token_file' }, renewedTo('nope'));
  assert.equal(await cloud.freshAuthToken({ env: {}, auth, apiRequestJson: () => {} }), placed);
  assert.equal(calls.length, 0);
});

test('an env token and a scoped agent token are used as is', async () => {
  const { auth, calls } = fakeAuth({ token: jwtWith({ type: 'agent_access', exp: nowSec() - 5 }), refresh_token: 'r' }, renewedTo('nope'));
  assert.equal(await cloud.freshAuthToken({ env: { ATRIS_TOKEN: 'from-env' }, auth }), 'from-env');
  assert.match(await cloud.freshAuthToken({ env: {}, auth, apiRequestJson: () => {} }), /\./);
  assert.equal(calls.length, 0);
});

test('an ordinary login near its end is renewed without a second check, and the new one is used', async () => {
  const old = jwtWith({ sub: 'u1', exp: nowSec() + 60 });
  const { auth, calls } = fakeAuth({ token: old, refresh_token: 'refresh-1' }, renewedTo('renewed-token'));
  assert.equal(await cloud.freshAuthToken({ env: {}, auth, apiRequestJson: () => {} }), 'renewed-token');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].c.refresh_token, 'refresh-1');
  assert.deepEqual(calls[0].opts, { validate: false });
});

test('an ordinary login already past its end is renewed too', async () => {
  const old = jwtWith({ sub: 'u1', exp: nowSec() - 3600 });
  const { auth } = fakeAuth({ token: old, refresh_token: 'refresh-1' }, renewedTo('renewed-token'));
  assert.equal(await cloud.freshAuthToken({ env: {}, auth, apiRequestJson: () => {} }), 'renewed-token');
});

test('a fresh login is not renewed, and one without a refresh pass is used as is', async () => {
  const fresh = jwtWith({ sub: 'u1', exp: nowSec() + 7 * 86400 });
  const a = fakeAuth({ token: fresh, refresh_token: 'refresh-1' }, renewedTo('nope'));
  assert.equal(await cloud.freshAuthToken({ env: {}, auth: a.auth, apiRequestJson: () => {} }), fresh);
  assert.equal(a.calls.length, 0);
  const ending = jwtWith({ sub: 'u1', exp: nowSec() + 30 });
  const b = fakeAuth({ token: ending }, renewedTo('nope'));
  assert.equal(await cloud.freshAuthToken({ env: {}, auth: b.auth, apiRequestJson: () => {} }), ending);
  assert.equal(b.calls.length, 0);
});

test('a failed renewal keeps the old token so the server can say what is wrong', async () => {
  const old = jwtWith({ sub: 'u1', exp: nowSec() + 30 });
  const failing = fakeAuth({ token: old, refresh_token: 'r' }, async () => ({ ok: false, error: 'refresh refused' }));
  assert.equal(await cloud.freshAuthToken({ env: {}, auth: failing.auth, apiRequestJson: () => {} }), old);
  const throwing = fakeAuth({ token: old, refresh_token: 'r' }, async () => { throw new Error('offline'); });
  assert.equal(await cloud.freshAuthToken({ env: {}, auth: throwing.auth, apiRequestJson: () => {} }), old);
});

test('turns that start together share one renewal', async () => {
  const old = jwtWith({ sub: 'u1', exp: nowSec() + 30 });
  let release;
  const gate = new Promise((r) => { release = r; });
  const { auth, calls } = fakeAuth({ token: old, refresh_token: 'r' }, async () => { await gate; return { ok: true, payload: { credentials: { token: 'renewed-once' } } }; });
  const both = Promise.all([1, 2, 3].map(() => cloud.freshAuthToken({ env: {}, auth, apiRequestJson: () => {} })));
  release();
  assert.deepEqual(await both, ['renewed-once', 'renewed-once', 'renewed-once']);
  assert.equal(calls.length, 1);
});
