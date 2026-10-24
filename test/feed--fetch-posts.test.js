'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'feed-fetch-posts-'));
process.env.HOME = home;
for (const key of Object.keys(process.env)) {
  if (key.startsWith('ATRIS_')) delete process.env[key];
}
test.after(() => fs.rmSync(home, { recursive: true, force: true }));

// feed.js copies apiRequestJson at load, so the stand-in has to be installed first.
const api = require('../utils/api');
const realApiRequestJson = api.apiRequestJson;
const scenarios = new Map();
api.apiRequestJson = async (pathname, options = {}) => {
  const match = /^\/business\/([^/]+)\/feed\?limit=(\d+)&offset=(\d+)$/.exec(pathname);
  if (!match) throw new Error(`unexpected feed path: ${pathname}`);
  const scenario = scenarios.get(match[1]);
  if (!scenario) throw new Error(`unexpected business: ${match[1]}`);
  const call = {
    pathname,
    token: options.token,
    timeoutMs: options.timeoutMs,
    offset: Number(match[3]),
    limit: Number(match[2]),
  };
  scenario.calls.push(call);
  return scenario.respond(call);
};
test.after(() => {
  api.apiRequestJson = realApiRequestJson;
});

const { fetchPosts } = require('../commands/feed');

function scenario(businessId, respond) {
  const record = { calls: [], respond };
  scenarios.set(businessId, record);
  return record;
}

function postsOf(count, prefix) {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}${index}`,
    content: `note ${prefix}${index}`,
  }));
}

test('fetchPosts follows full pages and returns every post it fetched', async () => {
  const first = postsOf(100, 'a');
  const second = postsOf(3, 'b');
  const seen = scenario('biz-normal', (call) => ({
    status: 200,
    data: { posts: call.offset === 0 ? first : second },
  }));

  const posts = await fetchPosts('biz-normal', 'fixed-token', 300);

  assert.deepStrictEqual(posts, first.concat(second));
  assert.deepStrictEqual(seen.calls.map((call) => call.pathname), [
    '/business/biz-normal/feed?limit=100&offset=0',
    '/business/biz-normal/feed?limit=100&offset=100',
  ]);
  assert.deepStrictEqual(seen.calls.map((call) => ({
    token: call.token,
    timeoutMs: call.timeoutMs,
    limit: call.limit,
  })), [
    { token: 'fixed-token', timeoutMs: 20000, limit: 100 },
    { token: 'fixed-token', timeoutMs: 20000, limit: 100 },
  ]);
});

test('fetchPosts stops once it has enough, accepts a bare list, and treats empty input as no posts', async () => {
  const full = scenario('biz-full', () => ({
    status: 200,
    data: { posts: postsOf(100, 'f') },
  }));
  const fullPosts = await fetchPosts('biz-full', 'tok-full', 1);
  assert.strictEqual(fullPosts.length, 100);
  assert.strictEqual(fullPosts[0].id, 'f0');
  assert.strictEqual(fullPosts[99].id, 'f99');
  assert.deepStrictEqual(full.calls.map((call) => call.offset), [0]);

  const bare = scenario('biz-bare', () => ({
    status: 200,
    data: [{ id: 'only', content: 'one row' }],
  }));
  assert.deepStrictEqual(await fetchPosts('biz-bare', 'tok-bare', 10), [
    { id: 'only', content: 'one row' },
  ]);
  assert.deepStrictEqual(bare.calls.map((call) => call.pathname), [
    '/business/biz-bare/feed?limit=100&offset=0',
  ]);

  const empty = scenario('biz-empty', () => ({ status: 200, data: { posts: [] } }));
  assert.deepStrictEqual(await fetchPosts('biz-empty', 'tok-empty', 15), []);
  assert.strictEqual(empty.calls.length, 1);

  const missing = scenario('biz-missing', () => ({ status: 200, data: { posts: 'nope' } }));
  assert.deepStrictEqual(await fetchPosts('biz-missing', 'tok-missing', 15), []);
  assert.strictEqual(missing.calls.length, 1);

  const idle = scenario('biz-zero', () => {
    throw new Error('a want of zero must not fetch');
  });
  assert.deepStrictEqual(await fetchPosts('biz-zero', 'tok-zero', 0), []);
  assert.deepStrictEqual(idle.calls, []);
});

test('fetchPosts throws the feed status and body and does not keep a partial page', async () => {
  const denied = scenario('biz-denied', () => ({
    status: 403,
    data: { detail: 'nope' },
  }));
  await assert.rejects(
    () => fetchPosts('biz-denied', 'tok-denied', 5),
    (error) => {
      assert.ok(error instanceof Error);
      assert.strictEqual(error.message, 'Feed fetch failed (403): {"detail":"nope"}');
      return true;
    },
  );
  assert.deepStrictEqual(denied.calls.map((call) => call.offset), [0]);

  const later = scenario('biz-later', (call) => {
    if (call.offset === 0) return { status: 200, data: { posts: postsOf(100, 'p') } };
    return { statusCode: 500, data: { error: 'later' } };
  });
  await assert.rejects(
    () => fetchPosts('biz-later', 'tok-later', 150),
    (error) => {
      assert.strictEqual(error.message, 'Feed fetch failed (500): {"error":"later"}');
      return true;
    },
  );
  assert.deepStrictEqual(later.calls.map((call) => call.offset), [0, 100]);
});
