'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { screenNewProspect } = require('../lib/nexus-new-only-screen');

const candidate = { token: 'fictional-token', name: 'Mina Example', email: 'mina@example.test' };
const clear = { status: 'clear', checked: { gmail: 2, calendar: 1, contacts: 0 }, contacts_scope: 'not_connected' };
const run = (response) => screenNewProspect({ ...candidate, request: async () => response });

test('uses a single authenticated lookup with private search terms in its body', async () => {
  let calls = 0;
  const result = await screenNewProspect({ ...candidate, request: async (route, options) => {
    calls++;
    assert.equal(route, '/integrations/google/known-person');
    assert.equal(options.token, candidate.token);
    assert.equal(options.method, 'POST');
    assert.deepEqual(options.body, { name: candidate.name, email: candidate.email });
    return { ok: true, data: { ...clear, snippet: 'private message text' } };
  } });
  assert.equal(calls, 1);
  assert.deepEqual(result, clear);
});

test('matches are reported without returning the contact or their message', async () => {
  const hit = { ...clear, status: 'matched' };
  assert.deepEqual(await run({ ok: true, data: { ...hit, name: candidate.name } }), hit);
});

test('missing capability, ambiguous coverage and service failures cannot authorize a capture', async () => {
  for (const response of [
    { ok: false, status: 404 }, { ok: false, status: 503 }, { ok: true, data: { status: 'clear' } },
    { ok: true, data: { ...clear, checked: { gmail: 0, calendar: 0, contacts: 0 } } },
    { ok: true, data: { ...clear, contacts_scope: 'connected' } },
    { ok: true, data: { ...clear, checked: { gmail: -1, calendar: 1, contacts: 0 } } },
  ]) assert.equal((await run(response)).status, 'unavailable');
  assert.equal((await screenNewProspect({ ...candidate, request: async () => { throw Error('timeout'); } })).status, 'unavailable');
  assert.equal((await run({ ok: true, data: { ...clear, status: 'unavailable' } })).status, 'unavailable');
});
