'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { trustCommand } = require('../commands/trust');

function harness(reply) {
  const calls = [];
  const out = [];
  const err = [];
  const io = {
    token: 'test-token',
    log: (line) => out.push(String(line)),
    error: (line) => err.push(String(line)),
    request: async (pathname, options) => {
      calls.push({ pathname, options: options || {} });
      return reply;
    },
  };
  return { io, calls, out, err };
}

const ok = (data) => ({ ok: true, status: 200, data });

test('atris trust with no handle shows my trust', async () => {
  const h = harness(ok({
    user_id: 'me-id', handle: 'keshav', trust_score: 12, friends: 12,
    trusted_with_me: null, shared_friends: null,
  }));
  assert.equal(await trustCommand([], h.io), 0);
  assert.equal(h.calls[0].pathname, '/trust/me');
  assert.equal(h.calls[0].options.token, 'test-token');
  assert.deepEqual(h.out, ['@keshav (you)', '  Trust score 12, from 12 friends']);
});

test('a new account with no friends gets a next step', async () => {
  const h = harness(ok({ user_id: 'me-id', handle: 'new', trust_score: 0, friends: 0 }));
  assert.equal(await trustCommand([], h.io), 0);
  assert.match(h.out.join('\n'), /atris people/);
});

test('atris trust @handle strips the @ and shows what we share', async () => {
  const h = harness(ok({
    user_id: 'nora-id', handle: 'nora', trust_score: 4, friends: 4,
    trusted_with_me: true, shared_friends: 2,
  }));
  assert.equal(await trustCommand(['@nora'], h.io), 0);
  assert.equal(h.calls[0].pathname, '/trust/nora');
  assert.deepEqual(h.out, [
    '@nora',
    '  Trust score 4, from 4 friends',
    '  Trusted with you: yes',
    '  Friends you share: 2',
  ]);
});

test('emails are encoded into the path', async () => {
  const h = harness(ok({ user_id: 'x', handle: 'nora', trust_score: 1, friends: 1 }));
  assert.equal(await trustCommand(['nora@example.com'], h.io), 0);
  assert.equal(h.calls[0].pathname, '/trust/nora%40example.com');
  assert.match(h.out[1], /from 1 friend$/);
});

test('--json prints the raw trust view', async () => {
  const data = { user_id: 'nora-id', handle: 'nora', trust_score: 4, friends: 4, trusted_with_me: false, shared_friends: 0 };
  const h = harness(ok(data));
  assert.equal(await trustCommand(['nora', '--json'], h.io), 0);
  assert.deepEqual(JSON.parse(h.out.join('\n')), data);
});

test('vouch posts and unvouch deletes, both with the @ stripped', async () => {
  let h = harness(ok({ status: 'vouched', user_id: 'nora-id', is_mutual: false }));
  assert.equal(await trustCommand(['vouch', '@nora'], h.io), 0);
  assert.equal(h.calls[0].pathname, '/trust/vouch/nora');
  assert.equal(h.calls[0].options.method, 'POST');
  assert.deepEqual(h.out, ['You vouched for @nora.']);

  h = harness(ok({ status: 'vouched', user_id: 'nora-id', is_mutual: true }));
  assert.equal(await trustCommand(['vouch', 'nora'], h.io), 0);
  assert.deepEqual(h.out, ['You vouched for @nora. You vouch for each other now.']);

  h = harness(ok({ status: 'unvouched', user_id: 'nora-id' }));
  assert.equal(await trustCommand(['unvouch', '@nora'], h.io), 0);
  assert.equal(h.calls[0].pathname, '/trust/vouch/nora');
  assert.equal(h.calls[0].options.method, 'DELETE');
  assert.deepEqual(h.out, ['You took back your vouch for @nora.']);
});

test('vouch --json prints the raw answer', async () => {
  const data = { status: 'vouched', user_id: 'nora-id', is_mutual: false };
  const h = harness(ok(data));
  assert.equal(await trustCommand(['vouch', 'nora', '--json'], h.io), 0);
  assert.deepEqual(JSON.parse(h.out.join('\n')), data);
});

test('vouch without a handle prints usage', async () => {
  const h = harness(ok({}));
  assert.equal(await trustCommand(['vouch'], h.io), 2);
  assert.equal(h.calls.length, 0);
  assert.match(h.err[0], /Usage: atris trust vouch/);
});

test('a blocked vouch prints the server message', async () => {
  const h = harness({ ok: false, status: 403, data: { detail: { error: 'blocked', message: 'You cannot vouch for this account' } } });
  assert.equal(await trustCommand(['vouch', 'nora'], h.io), 1);
  assert.deepEqual(h.err, ['You cannot vouch for this account']);
});

test('an unknown handle prints the server message', async () => {
  const h = harness({ ok: false, status: 404, data: { detail: 'No account with that handle' } });
  assert.equal(await trustCommand(['ghost'], h.io), 1);
  assert.deepEqual(h.err, ['No account with that handle']);
});

test('help prints and exits 0', async () => {
  const h = harness(ok({}));
  assert.equal(await trustCommand(['--help'], h.io), 0);
  assert.match(h.out.join('\n'), /atris trust vouch <handle>/);
  assert.equal(h.calls.length, 0);
});
