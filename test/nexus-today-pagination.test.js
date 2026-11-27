'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { nexusCommand } = require('../commands/nexus');

const person = (id, name = `Person ${id}`) => ({ id, name, reason: 'follow_up_due', days: 0 });
const page = (people, extra = {}) => ({ today: '2026-11-17', tz: 'Europe/London', total: 4, people, ...extra });

// Run the real command and rendering, replacing only login and the HTTP boundary.
async function run(args, pages, tz = 'Europe/London') {
  const calls = [];
  const out = [];
  const err = [];
  const code = await nexusCommand(args, {
    tz,
    getToken: async () => ({ token: 'test-token' }),
    log: (line) => out.push(line),
    err: (line) => err.push(line),
    apiRequestJson: async (pathname, options) => {
      assert.equal(options.method, 'GET');
      assert.equal(options.token, 'test-token');
      assert.ok(calls.length < pages.length, `unexpected extra request: ${pathname}`);
      calls.push(pathname);
      const data = pages[calls.length - 1];
      return data.failure || { ok: true, status: 200, data };
    },
  });
  return { code, out, err, calls };
}

test('--all follows Today cursors with the original first request, timezone and JSON shape', async () => {
  const first = page([person('a'), person('b')], { limit: 2, offset: 0, next_offset: 2, extra: 'kept' });
  const result = await run(['--all', '--json'], [
    first,
    page([person('b', 'Renamed while paging'), person('c')], { next_offset: 4 }),
    page([person('d')], { next_offset: null }),
  ]);
  assert.equal(result.code, 0);
  assert.deepEqual(result.calls, [
    '/nexus/today?tz=Europe%2FLondon',
    '/nexus/today?tz=Europe%2FLondon&offset=2',
    '/nexus/today?tz=Europe%2FLondon&offset=4',
  ]);
  assert.deepEqual(result.err, []);
  assert.equal(result.out.length, 1);
  assert.deepEqual(JSON.parse(result.out[0]), {
    ...first, people: ['a', 'b', 'c', 'd'].map((id) => person(id)), next_offset: null,
  });
  assert.equal(first.people.length, 2, 'the original response is not mutated');
  assert.equal(first.next_offset, 2);
});

test('--all prints every Today row while the ordinary display and JSON stay on one page', async () => {
  const people = Array.from({ length: 7 }, (_, i) => person(String(i)));
  const first = page(people.slice(0, 6), { total: 7, next_offset: 6 });
  for (const args of [[], ['--json']]) {
    const result = await run(args, [first]);
    assert.equal(result.code, 0);
    assert.equal(result.calls.length, 1);
    if (args.length) assert.deepEqual(JSON.parse(result.out[0]), first);
    else {
      assert.equal(result.out.filter((line) => line.includes('Follow-up is due today.')).length, 5);
      assert.match(result.out.at(-1), /Showing 5 of 7\. Add --all for the rest\./);
    }
  }
  const result = await run(['--all'], [first, page(people.slice(6), { total: 7, next_offset: null })]);
  assert.equal(result.code, 0);
  assert.deepEqual(result.err, []);
  assert.equal(result.out.filter((line) => line.includes('Follow-up is due today.')).length, 7);
  assert.doesNotMatch(result.out.join('\n'), /Showing|Add --all/);
});

test('--all uses advancing cursors despite changing totals and duplicate-only pages', async () => {
  const result = await run(['--all', '--json'], [
    page([person('a')], { total: 1, next_offset: 1 }),
    page([person('a', 'Changed name')], { total: 2, next_offset: 2 }),
    page([person('b')], { total: 2, next_offset: null }),
  ], '');
  assert.equal(result.code, 0);
  assert.deepEqual(result.calls, ['/nexus/today', '/nexus/today?offset=1', '/nexus/today?offset=2']);
  assert.deepEqual(JSON.parse(result.out[0]).people, [person('a'), person('b')]);
});

test('--all stops before requesting malformed, missing or non-advancing first cursors', async () => {
  for (const cursor of [undefined, null, 0, -1, 1.5, '2', '', true, [], {}, Number.MAX_SAFE_INTEGER + 1]) {
    const first = page([person('a')]);
    if (cursor !== undefined) first.next_offset = cursor;
    const result = await run(['--all', '--json'], [first]);
    assert.equal(result.code, 0, JSON.stringify(cursor));
    assert.equal(result.calls.length, 1, JSON.stringify(cursor));
    assert.deepEqual(JSON.parse(result.out[0]), first);
  }
});

test('--all stops on repeated, backward, malformed or missing later cursors without losing loaded people', async () => {
  for (const cursor of [2, 1, 0, '4', {}, undefined, null]) {
    const last = page([person('b')]);
    if (cursor !== undefined) last.next_offset = cursor;
    const result = await run(['--all', '--json'], [page([person('a')], { next_offset: 2 }), last]);
    assert.equal(result.code, 0, JSON.stringify(cursor));
    assert.equal(result.calls.length, 2, JSON.stringify(cursor));
    const body = JSON.parse(result.out[0]);
    assert.deepEqual(body.people, [person('a'), person('b')]);
    assert.deepEqual(body.next_offset, cursor);
    assert.equal(Object.hasOwn(body, 'next_offset'), cursor !== undefined);
  }
});

test('--all deduplicates by id, preserving distinct people with the same name and rows without ids', async () => {
  const unnamedId = { name: 'No id', reason: 'follow_up_due', days: 0 };
  const result = await run(['--all', '--json'], [
    page([person('a', 'Same name'), person('a', 'Repeated id'), unnamedId], { next_offset: 3 }),
    page([person('a', 'Changed name'), person('b', 'Same name'), unnamedId], { next_offset: null }),
  ]);
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.out[0]).people, [person('a', 'Same name'), unnamedId, person('b', 'Same name'), unnamedId]);
});

test('--all stops on an empty or malformed page even when its cursor advances', async () => {
  for (const people of [[], null, {}]) {
    const result = await run(['--all', '--json'], [
      page([person('a')], { next_offset: 2 }), page(people, { next_offset: 4 }),
    ]);
    assert.equal(result.code, 0);
    assert.equal(result.calls.length, 2);
    assert.deepEqual(JSON.parse(result.out[0]).people, [person('a')]);
  }
});

test('older APIs that truncate Today keep their total and a partial display without guessing offsets', async () => {
  const first = page([person('a'), person('b')], { total: 200 });
  const plain = await run(['--all'], [first]);
  assert.equal(plain.code, 0);
  assert.equal(plain.calls.length, 1);
  assert.match(plain.out.at(-1), /Showing 2 of 200\.$/);
  assert.doesNotMatch(plain.out.join('\n'), /Add --all/);
  const json = await run(['--all', '--json'], [first]);
  assert.equal(json.code, 0);
  assert.deepEqual(JSON.parse(json.out[0]), first, 'no invented completeness flag or rewritten total');
});

test('a later Today request failure does not silently fall back to the saved list', async () => {
  const result = await run(['--all', '--json'], [
    page([person('a')], { next_offset: 2 }),
    { failure: { ok: false, status: 500, error: 'unavailable' } },
  ]);
  assert.equal(result.code, 1);
  assert.equal(result.calls.length, 2);
  assert.deepEqual(result.err, []);
  assert.deepEqual(JSON.parse(result.out[0]), { ok: false, error: 'The people store did not answer.' });
});
