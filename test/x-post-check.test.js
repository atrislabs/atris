'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  parsePosts,
  parseCitations,
  fetchXPost,
  textAgrees,
  matchPosts,
  checkXPosts,
  annotateContent,
  formatTally,
  UNMATCHED_NOTE,
  UNKNOWN_NOTE,
} = require('../lib/x-post-check');
const { xSearchCommand, formatXSearchResult, runXSearchBench } = require('../commands/x-search');
const {
  FIXTURE,
  parseArgs,
  selectCases,
  parseTally,
  judgePaid,
  judgeStranger,
  fixtureFetch,
  runOfflineCheck,
  saveFailedOutput,
  summary,
} = require('../scripts/det/xsearch-bench');

const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
const CREDS = async () => ({ credentials: { token: 'token-123', agent_token: 'token-123', agent_token_scopes: ['x-search', 'youtube'], agent_token_expires_at: '2099-01-01T00:00:00Z' } });

function noNetwork() {
  return async () => { throw new Error('network is off in tests'); };
}

function searchDeps(extra = {}) {
  const output = [];
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-x-post-check-'));
  return {
    output,
    deps: {
      cwd,
      output: (line = '') => output.push(String(line)),
      ensureValidCredentials: CREDS,
      apiRequestJson: async () => ({
        ok: true,
        status: 200,
        data: {
          status: 'success',
          credits_used: 5,
          credits_remaining: 995,
          data: { content: fixture.content, citations: fixture.citations },
        },
      }),
      fetch: noNetwork(),
      ...extra,
    },
  };
}

// Parser

test('parsePosts reads the real Grok format: bold handle and Full tweet text', () => {
  const posts = parsePosts(fixture.content);
  assert.equal(posts.length, 4);
  assert.deepEqual(posts.map((p) => p.handle), ['shivanipod', 'garrytan', 'levelsio', 'swyx']);
  assert.equal(posts[0].text, "I led engineering at Google DeepMind. Today, I'm proud to introduce Fo ...");
  const lines = fixture.content.split('\n');
  assert.match(lines[posts[0].line], /Full tweet text/);
  assert.match(lines[posts[3].line], /agent engineer is the new full stack/);
});

test('parsePosts reads a variant with (@handle) and a bare curly-quoted span', () => {
  const content = [
    'Top posts:',
    '1. Garry Tan (@garrytan) wrote on Sep 28:',
    '   “Every founder should be building agents right now, the window is open.”',
    '   Likes: 2,100',
    '2. Shivani (@shivanipod): “I led engineering at Google DeepMind and now I build agents.”',
  ].join('\n');
  const posts = parsePosts(content);
  assert.equal(posts.length, 2);
  assert.equal(posts[0].handle, 'garrytan');
  assert.equal(posts[0].text, 'Every founder should be building agents right now, the window is open.');
  assert.equal(posts[0].line, 2);
  assert.equal(posts[1].handle, 'shivanipod');
  assert.equal(posts[1].line, 4);
});

test('parsePosts reads a person variant with no handle, an unquoted Tweet label, and an inline link', () => {
  const content = [
    '### Recent posts',
    '- **Sep 28, 2026**',
    '1. Tweet: Congrats @ycombinator on the biggest demo day yet, agents everywhere',
    '   Link: https://x.com/garrytan/status/1972000000000000009',
    '2. Text: short one',
  ].join('\n');
  const posts = parsePosts(content, { defaultHandle: '@garrytan' });
  assert.equal(posts.length, 1);
  assert.equal(posts[0].handle, 'garrytan', 'a mention inside the quote is not the author');
  assert.equal(posts[0].text, 'Congrats @ycombinator on the biggest demo day yet, agents everywhere');
  assert.equal(posts[0].linkedId, '1972000000000000009');
});

test('parsePosts reads the live 2026-09-29 format: bold number and label with the colon inside', () => {
  const content = [
    '**Here are the 5 most relevant posts** from the last 2 days:',
    '',
    '**1. Author: @TradexWhisperer**  ',
    '**Exact date/time: Sun, 27 Sep 2026 05:26:50 GMT**  ',
    '**Engagement: Likes=235, Reposts=11, Views=59530**  ',
    '**Full tweet text:** "Sorry folks Agentic AI isn\'t coming. It\'s already here. 8 launches in under a year: OpenAI Agents, Claude."',
    '',
    '**2. Author: @newsfile_corp**  ',
    '**Full tweet text:** "Ember Origin Launches AI Platform for Entrepreneurs, Surpasses 1,000 Sign-Ups Full Story: https://www.newsfilecorp.com/release/315844 #AIPlatform"',
  ].join('\n');
  const posts = parsePosts(content);
  assert.deepEqual(posts.map((p) => [p.handle, p.line]), [['TradexWhisperer', 5], ['newsfile_corp', 8]]);
  assert.match(posts[0].text, /^Sorry folks Agentic AI/);
  assert.ok(textAgrees(posts[1].text, 'Ember Origin Launches AI Platform for Entrepreneurs, Surpasses 1,000 Sign-Ups Within Two Weeks https://t.co/x'));
});

test('parsePosts reads blockquoted text and markdown tables', () => {
  const quoted = parsePosts([
    '**1.** **@foo** (Sep 28)',
    '> Launched our agent startup today, come try it out',
    '> second line here',
    '',
    'Post 2: @bar',
    '**Text:**',
    '> We raised a seed round for our agent company',
  ].join('\n'));
  assert.deepEqual(quoted.map((p) => [p.handle, p.text, p.line]), [
    ['foo', 'Launched our agent startup today, come try it out second line here', 2],
    ['bar', 'We raised a seed round for our agent company', 6],
  ]);

  const table = parsePosts([
    '| # | Author | Date | Text | Likes |',
    '|---|---|---|---|---|',
    '| 1 | @foo | Sep 28 | Launched our agent startup today, come try it out | 12 |',
    '| 2 | @bar | Sep 27 | "We raised a seed round for our agent company" | 3 |',
  ].join('\n'));
  assert.deepEqual(table.map((p) => [p.handle, p.text, p.line]), [
    ['foo', 'Launched our agent startup today, come try it out', 2],
    ['bar', 'We raised a seed round for our agent company', 3],
  ]);
});

test('parsePosts finds nothing in answers with no quoted posts', () => {
  assert.deepEqual(parsePosts('1. @levelsio: MCP agents are shipping.'), []);
  assert.deepEqual(parsePosts(''), []);
  assert.deepEqual(parsePosts('Profile notes'), []);
});

test('parseCitations keeps order, dedupes status ids, and keeps non-status links', () => {
  const cites = parseCitations([
    'https://x.com/i/status/111111',
    'https://twitter.com/GarryTan/status/222222?s=20',
    'https://x.com/i/status/111111',
    'https://x.com/leahbon',
    '',
  ]);
  assert.deepEqual(cites, [
    { url: 'https://x.com/i/status/111111', id: '111111', handle: null },
    { url: 'https://twitter.com/GarryTan/status/222222?s=20', id: '222222', handle: 'GarryTan' },
    { url: 'https://x.com/leahbon', id: null, handle: null },
  ]);
});

// Matching

test('textAgrees accepts truncated quotes and word overlap, rejects other posts', () => {
  assert.equal(textAgrees('I led engineering at Google DeepMind. Today ...', "I led engineering at Google DeepMind. Today, I'm proud https://t.co/x"), true);
  assert.equal(textAgrees('engineering led I at DeepMind Google today', 'I led engineering at Google DeepMind today'), true);
  assert.equal(textAgrees('Launched my new AI agent that books every flight', 'Spent the whole day fixing my server.'), false);
});

test('matchPosts marks checked, unmatched, and unknown', () => {
  const posts = parsePosts(fixture.content);
  const up = fixture.citations.map((url) => url.split('/').pop()).map((id) => {
    const post = fixture.embeds[id];
    return post ? { id, ok: true, post: { ...post, id } } : { id, ok: true, post: null };
  });
  const checks = matchPosts(posts, up);
  assert.deepEqual(checks.map((c) => c.status), ['checked', 'checked', 'unmatched', 'checked']);
  assert.equal(checks[1].url, 'https://x.com/GarryTan/status/1972000000000000002', 'link uses the real handle');

  const down = up.map((r) => (r.id === '1972000000000000004' ? { id: r.id, ok: false, error: 'timeout' } : r));
  assert.deepEqual(matchPosts(posts, down).map((c) => c.status), ['checked', 'checked', 'unknown', 'unknown']);
});

test('matchPosts needs the handle to agree, not just the words', () => {
  const posts = [{ index: 1, handle: 'someoneelse', text: 'The agent engineer is the new full stack engineer' }];
  const results = [{ id: '4', ok: true, post: { id: '4', handle: 'swyx', text: 'The agent engineer is the new full stack engineer' } }];
  assert.equal(matchPosts(posts, results)[0].status, 'unmatched');
});

test('checkXPosts puts noise citations in other sources and returns null with no posts', async () => {
  const result = await checkXPosts({ content: fixture.content, citations: fixture.citations, fetchPost: fixtureFetch(fixture.embeds) });
  assert.deepEqual(result.tally, { checked: 3, unmatched: 1, unknown: 0 });
  assert.deepEqual(result.otherSources, [
    'https://x.com/i/status/1972000000000000003',
    'https://x.com/i/status/1972000000000000005',
    'https://x.com/i/status/1972000000000000006',
  ]);
  assert.equal(await checkXPosts({ content: 'no posts here', citations: fixture.citations, fetchPost: noNetwork() }), null);
});

test('checkXPosts treats a throwing lookup as unknown, never as fake', async () => {
  const result = await checkXPosts({ content: fixture.content, citations: fixture.citations, fetchPost: noNetwork() });
  assert.deepEqual(result.tally, { checked: 0, unmatched: 0, unknown: 4 });
});

test('checkXPosts looks up at most 15 ids', async () => {
  const seen = [];
  const citations = Array.from({ length: 30 }, (_, i) => `https://x.com/i/status/${100000 + i}`);
  await checkXPosts({ content: fixture.content, citations, fetchPost: async (id) => { seen.push(id); return { ok: true, post: null }; } });
  assert.equal(seen.length, 15);
});

test('fetchXPost reads the embed json and tells missing from unreachable', async () => {
  const fake = (status, body) => async (url) => {
    assert.match(url, /^https:\/\/cdn\.syndication\.twimg\.com\/tweet-result\?id=42&token=a$/);
    return { status, ok: status >= 200 && status < 300, json: async () => body };
  };
  assert.deepEqual(
    await fetchXPost('42', { fetch: fake(200, { user: { screen_name: 'jack' }, text: 'just setting up my twttr', created_at: '2006-03-21T20:50:14.000Z' }) }),
    { id: '42', ok: true, post: { id: '42', handle: 'jack', text: 'just setting up my twttr', createdAt: '2006-03-21T20:50:14.000Z' } },
  );
  assert.deepEqual(await fetchXPost('42', { fetch: fake(404, null) }), { id: '42', ok: true, post: null });
  assert.equal((await fetchXPost('42', { fetch: fake(500, null) })).ok, false);
  assert.equal((await fetchXPost('42', { fetch: noNetwork() })).ok, false);
});

test('annotateContent puts the link or warning right under each quote', async () => {
  const result = await checkXPosts({ content: fixture.content, citations: fixture.citations, fetchPost: fixtureFetch(fixture.embeds) });
  const lines = annotateContent(fixture.content, result).split('\n');
  const first = lines.findIndex((l) => l.includes('Full tweet text') && l.includes('Google DeepMind'));
  assert.equal(lines[first + 1], '   https://x.com/shivanipod/status/1972000000000000001 (checked)');
  const third = lines.findIndex((l) => l.includes('books every flight'));
  assert.equal(lines[third + 1], `   ${UNMATCHED_NOTE}`);
  assert.equal(formatTally(result.tally), 'posts: 3 checked, 1 unverified, 0 unknown');
});

// Wired into x-search

test('x-search prints per-post links, other sources, and the tally', async () => {
  const { output, deps } = searchDeps({ fetchPost: fixtureFetch(fixture.embeds) });
  const status = await xSearchCommand(['AI agent startups launch', '--limit', '5', '--days', '2'], deps);
  assert.equal(status, 0);
  const text = output.join('\n');
  assert.match(text, /https:\/\/x\.com\/shivanipod\/status\/1972000000000000001 \(checked\)/);
  assert.match(text, /could not find this post on X, treat as unverified/);
  assert.match(text, /Other sources:\n {2}https:\/\/x\.com\/i\/status\/1972000000000000003\n/);
  assert.doesNotMatch(text, /Citations:/);
  assert.doesNotMatch(text, / {2}https:\/\/x\.com\/i\/status\/1972000000000000001$/m);
  assert.match(text, /Credits: 5 used, 995 remaining/);
  assert.match(text, /posts: 3 checked, 1 unverified, 0 unknown/);
});

test('x-search marks posts unknown when X cannot be reached, and still exits 0', async () => {
  const { output, deps } = searchDeps({ fetchPost: noNetwork() });
  assert.equal(await xSearchCommand(['AI agent startups launch'], deps), 0);
  const text = output.join('\n');
  assert.equal(text.split(UNKNOWN_NOTE).length - 1, 4);
  assert.match(text, /posts: 0 checked, 0 unverified, 4 unknown/);
});

test('x-search --no-check prints the original output', async () => {
  let looked = 0;
  const { output, deps } = searchDeps({ fetchPost: async () => { looked += 1; return { ok: false }; } });
  assert.equal(await xSearchCommand(['AI agent startups launch', '--no-check'], deps), 0);
  assert.equal(looked, 0);
  const text = output.join('\n');
  assert.match(text, /Citations:/);
  assert.doesNotMatch(text, /posts: \d+ checked/);
});

test('x-search --json adds a checks list and nothing else', async () => {
  const { output, deps } = searchDeps({ fetchPost: fixtureFetch(fixture.embeds) });
  assert.equal(await xSearchCommand(['AI agent startups launch', '--json'], deps), 0);
  const parsed = JSON.parse(output[0]);
  assert.deepEqual(Object.keys(parsed), ['status', 'credits_used', 'credits_remaining', 'data', 'checks']);
  assert.deepEqual(parsed.data.citations, fixture.citations);
  assert.deepEqual(parsed.checks.map((c) => c.status), ['checked', 'checked', 'unmatched', 'checked']);
});

test('x-search person passes the handle so posts without @ still get checked', async () => {
  let seenHandle;
  const { deps } = searchDeps({
    checkXPosts: async (args) => { seenHandle = args.defaultHandle; return null; },
  });
  await xSearchCommand(['person', '--name', 'Garry Tan', '--handle', 'garrytan'], deps);
  assert.equal(seenHandle, 'garrytan');
});

test('a throwing checker falls back to the original output', async () => {
  const { output: plain, deps: plainDeps } = searchDeps();
  await xSearchCommand(['AI agent startups launch', '--no-check'], plainDeps);

  const { output, deps } = searchDeps({ checkXPosts: async () => { throw new Error('boom'); } });
  assert.equal(await xSearchCommand(['AI agent startups launch'], deps), 0);
  assert.deepEqual(output, plain);

  const { output: bad, deps: badDeps } = searchDeps({ checkXPosts: async () => ({ posts: null, checks: null }) });
  assert.equal(await xSearchCommand(['AI agent startups launch'], badDeps), 0);
  assert.deepEqual(bad, plain);
});

test('formatXSearchResult without a check is unchanged', () => {
  const data = { credits_used: 5, data: { content: 'hello', citations: ['https://x.com/i/status/1'] } };
  assert.equal(formatXSearchResult(data), 'hello\n\nCitations:\n  https://x.com/i/status/1\n\nCredits: 5 used, ? remaining');
});

// Bench

test('bench case selection: --free is 0 credits, --quick adds only topic', () => {
  assert.deepEqual(selectCases(parseArgs(['--free'])).map((c) => c.name), ['stranger-logged-out', 'offline-check']);
  assert.deepEqual(selectCases(parseArgs(['--quick'])).map((c) => c.name), ['topic', 'stranger-logged-out', 'offline-check']);
  assert.deepEqual(selectCases(parseArgs([])).map((c) => c.name), ['topic', 'person', 'stranger-logged-out', 'offline-check']);
  assert.deepEqual(selectCases(parseArgs(['--case', 'person'])).map((c) => c.name), ['person']);
  assert.throws(() => parseArgs(['--nope']), /unknown option/);
  assert.throws(() => selectCases(parseArgs(['--case', 'nope'])), /unknown case/);
});

test('bench parses the tally and judges paid runs', () => {
  const tally = parseTally('...\nposts: 4 checked, 1 unverified, 0 unknown\n');
  assert.deepEqual(tally, { checked: 4, unverified: 1, unknown: 0 });
  assert.equal(parseTally('no tally'), null);
  assert.equal(judgePaid({ status: 0, tally, minPosts: 3 }).pass, true);
  assert.equal(judgePaid({ status: 0, tally: { checked: 1, unverified: 2, unknown: 0 }, minPosts: 3 }).pass, false);
  assert.equal(judgePaid({ status: 0, tally: { checked: 2, unverified: 0, unknown: 0 }, minPosts: 3 }).pass, false);
  assert.equal(judgePaid({ status: 1, tally, minPosts: 3 }).pass, false);
  assert.equal(judgePaid({ status: 0, tally: null, minPosts: 1 }).pass, false);
});

test('bench judges the logged-out stranger', () => {
  assert.equal(judgeStranger({ status: 1, text: 'not signed in. run atris login first.', hits: 0 }).pass, true);
  assert.equal(judgeStranger({ status: 1, text: 'not signed in. run atris login first.', hits: 1 }).pass, false);
  assert.equal(judgeStranger({ status: 0, text: 'not signed in. run atris login first.', hits: 0 }).pass, false);
  assert.equal(judgeStranger({ status: 1, text: 'TypeError: boom', hits: 0 }).pass, false);
});

test('bench offline-check passes on the saved answer', async () => {
  const verdict = await runOfflineCheck();
  assert.equal(verdict.pass, true, verdict.note);
  assert.deepEqual(verdict.tally, { checked: 3, unverified: 1, unknown: 0 });
  assert.equal(summary([{ pass: true }, { pass: false }], 3), 'bench: 1/2 passed in 3s');
});

test('bench keeps the full output of a failed paid case', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xsearch-bench-out-'));
  const file = saveFailedOutput(dir, 'topic', '2026-09-29T08:47:25.053Z', 'the whole answer');
  assert.equal(path.basename(file), 'xsearch-topic-2026-09-29T08-47-25-053Z.txt');
  assert.equal(fs.readFileSync(file, 'utf8'), 'the whole answer');
});

test('atris x-search bench runs the bench script and returns its status', async () => {
  const calls = [];
  const code = runXSearchBench(['--free'], {
    spawnSync: (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      return { status: 1 };
    },
  });
  assert.equal(code, 1);
  assert.equal(calls[0].cmd, process.execPath);
  assert.match(calls[0].args[0], /scripts[/\\]det[/\\]xsearch-bench\.js$/);
  assert.deepEqual(calls[0].args.slice(1), ['--free']);
  assert.equal(calls[0].opts.stdio, 'inherit');

  const routed = await xSearchCommand(['bench', '--quick'], { output: () => {}, spawnSync: () => ({ status: 0 }) });
  assert.equal(routed, 0);
});
