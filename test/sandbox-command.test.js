'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { sandboxCommand } = require('../commands/sandbox');
const { NOT_LOGGED_IN } = require('../lib/developer-api');

async function run(args, { token = 'token', result = { ok: true, status: 200, data: {} } } = {}) {
  const calls = [], out = [], err = [];
  const code = await sandboxCommand(args, {
    loadCredentials: async () => token ? { token } : null,
    apiRequestJson: async (path, options) => { calls.push({ path, ...options }); return result; },
    log: (s) => out.push(s), err: (s) => err.push(s),
  });
  return { code, calls, out, err };
}

test('public list shows rows without a token', async () => {
  const r = await run([], { token: '', result: { ok: true, data: { sandboxes: [{ slug: 'bakery-lot', title: 'Bakery', brief: 'A name', owner: '@maya', count: 2, open: true }], next: 'atris sandbox look bakery-lot' } } });
  assert.equal(r.code, 0); assert.equal(r.calls[0].path, '/world/sandboxes'); assert.equal(r.calls[0].method, 'GET'); assert.equal(r.calls[0].token, ''); assert.match(r.out[0], /bakery-lot.*Bakery.*@maya/);
});

test('invalid names and malformed additions never call the network', async () => {
  for (const args of [['look', '../bad'], ['add', 'good-name'], ['add', 'good-name', '--note', 'hello', '--thing', 'bench']]) {
    const r = await run(args); assert.equal(r.code, 1); assert.equal(r.calls.length, 0);
  }
});

test('open sends the complete body', async () => {
  const r = await run(['open', 'Bakery', '--brief', 'Find a name', '--who', 'aligned', '--kinds', 'thing,note', '--each', '3', '--unlisted']);
  assert.deepEqual(r.calls[0].body, { title: 'Bakery', brief: 'Find a name', who: 'aligned', kinds: ['thing', 'note'], each: 3, listed: false });
  assert.equal(r.calls[0].method, 'POST'); assert.equal(r.calls[0].retries, 0);
});

test('add sends notes and things', async () => {
  const note = await run(['add', 'bakery-lot', '--note', 'Hello']);
  assert.deepEqual(note.calls[0].body, { kind: 'note', text: 'Hello' });
  const thing = await run(['add', 'bakery-lot', '--thing', 'bench', '--style', 'wood', '--colour', 'red', '--text', 'hi', '--small', 'small', '--count', '2']);
  assert.deepEqual(thing.calls[0].body, { kind: 'thing', thing: 'bench', style: 'wood', colour: 'red', text: 'hi', small: 'small', count: 2 });
  assert.equal(thing.calls[0].path, '/world/sandboxes/bakery-lot/contributions'); assert.equal(thing.calls[0].retries, 0);
});

test('review, removal, and owner controls use the right requests', async () => {
  for (const decision of ['accept', 'decline', 'ban']) {
    const r = await run([decision, 'bakery-lot', 'abc-123']);
    assert.equal(r.calls[0].path, '/world/sandboxes/bakery-lot/contributions/abc-123/review'); assert.deepEqual(r.calls[0].body, { decision }); assert.equal(r.calls[0].retries, 0);
  }
  for (const action of ['remove', 'close']) {
    const r = await run(action === 'remove' ? [action, 'bakery-lot', 'abc'] : [action, 'bakery-lot']);
    assert.equal(r.calls[0].method, 'DELETE'); assert.equal(r.calls[0].path, action === 'remove' ? '/world/sandboxes/bakery-lot/contributions/abc' : '/world/sandboxes/bakery-lot'); assert.equal(r.calls[0].retries, 0);
  }
  for (const action of ['pause', 'resume']) {
    const r = await run([action, 'bakery-lot']); assert.equal(r.calls[0].method, 'PATCH'); assert.deepEqual(r.calls[0].body, { open: action === 'resume' }); assert.equal(r.calls[0].retries, 0);
  }
});

test('mine requires login and backend detail is shown', async () => {
  const signedOut = await run(['mine'], { token: '' }); assert.equal(signedOut.code, 1); assert.deepEqual(signedOut.err, [NOT_LOGGED_IN]); assert.equal(signedOut.calls.length, 0);
  const bad = await run(['look', 'bakery-lot'], { result: { ok: false, status: 422, data: { detail: 'give a better name' }, error: 'other' } }); assert.equal(bad.code, 1); assert.deepEqual(bad.err, ['give a better name']);
});

test('json success and failure each print one line', async () => {
  const good = await run(['list', '--json'], { result: { ok: true, data: { sandboxes: [] } } }); assert.deepEqual(JSON.parse(good.out[0]), { ok: true, sandboxes: [] }); assert.equal(good.out.length, 1);
  const bad = await run(['list', '--json'], { result: { ok: false, status: 422, data: { detail: 'bad' } } }); assert.deepEqual(JSON.parse(bad.out[0]), { ok: false, error: 'bad', status: 422 }); assert.equal(bad.out.length, 1);
});

test('notes cannot inject terminal lines or controls', async () => {
  const r = await run(['look', 'bakery-lot'], { result: { ok: true, data: { sandbox: { title: 'Bakery', slug: 'bakery-lot', brief: 'Brief', open: true, who: 'anyone', kinds: ['note'], each: 1, count: 1, free: 2 }, contributions: [{ kind: 'note', text: 'hello\nthere\u001b[31m', by: 'Scout' }] } } });
  assert.match(r.out[0], /note  hello there \[31m  by Scout/); assert.ok(!r.out[0].includes('\u001b'));
});

test('guide prints plain text and list rollout is clear', async () => {
  const guide = await run(['guide'], { token: '', result: { ok: true, data: null, text: 'first\nsecond' } }); assert.equal(guide.out[0], 'first\nsecond');
  const rollout = await run(['list'], { result: { ok: false, status: 404, error: 'missing' } }); assert.equal(rollout.err[0], 'sandboxes are rolling out, try again shortly');
});

test('help all includes sandbox', () => {
  const cli = path.join(__dirname, '..', 'bin', 'atris.js');
  const result = spawnSync(process.execPath, [cli, 'help', '--all'], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
  assert.equal(result.status, 0); assert.match(result.stdout, /  sandbox    - Open a lot in town/);
});
