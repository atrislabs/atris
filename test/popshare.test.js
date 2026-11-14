'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  popshareCommand,
  localAtToIso,
  parseAddArgs,
  resolvePostId,
  todayText,
  listText,
  scoreText,
} = require('../commands/popshare');

const posts = [
  { id: 'aaaa1111bbbb', platform: 'x', status: 'scheduled', text: 'launch day post', scheduled_for: '2026-11-14T17:30:00.000Z', created_at: '2026-11-10T00:00:00Z' },
  { id: 'aaaa1111cccc', platform: 'linkedin', status: 'draft', text: 'a linkedin draft', created_at: '2026-11-11T00:00:00Z' },
  { id: 'dddd2222eeee', platform: 'blog', status: 'posted', title: 'My launch post', text: 'the long form piece', posted_at: '2026-11-12T15:00:00Z', created_at: '2026-11-09T00:00:00Z' },
];

const todayBoard = {
  scheduled_today: [posts[0]],
  posted_today: [posts[2]],
  due_by_hand: [{ id: 'ghi999', platform: 'instagram', status: 'scheduled', text: 'reel caption', scheduled_for: '2026-11-14T10:00:00Z' }],
  failed: [{ id: 'jkl000', platform: 'x', status: 'failed', text: 'oops', error: 'X is not connected. Connect it in Atris, then try again.' }],
  check: [],
  gaps: [
    { platform: 'linkedin', wanted: 1, have: 0, period: 'day' },
    { platform: 'blog', wanted: 1, have: 1, period: 'week' },
    { platform: 'tiktok', wanted: 2, have: 0, period: 'week' },
  ],
};

async function run(args, { result, token = 'tok', routes } = {}) {
  const out = [];
  const err = [];
  const calls = [];
  const code = await popshareCommand(args, {
    log: (line) => out.push(line),
    err: (line) => err.push(line),
    loadCredentials: () => (token ? { token } : null),
    apiRequestJson: async (path, options) => {
      calls.push({ path, options });
      if (routes) {
        for (const [match, reply] of routes) {
          if (path.startsWith(match)) {
            return typeof reply === 'function' ? reply(path, options) : reply;
          }
        }
      }
      return result || { ok: true, status: 200, data: {} };
    },
    timeZone: 'UTC',
  });
  return { code, out: out.join('\n'), err: err.join('\n'), calls };
}

test('localAtToIso reads wall time as local and returns UTC iso', () => {
  const iso = localAtToIso('2026-11-14 09:30');
  assert.strictEqual(iso, new Date(2026, 10, 14, 9, 30, 0).toISOString());
  assert.strictEqual(localAtToIso('2026-11-14T09:30:15'), new Date(2026, 10, 14, 9, 30, 15).toISOString());
  assert.strictEqual(localAtToIso('not a time'), null);
  assert.strictEqual(localAtToIso('2026-02-31 10:00'), null);
  assert.strictEqual(localAtToIso('2026-11-14'), null);
});

test('parseAddArgs builds a draft by default and a scheduled post with --at', () => {
  const draft = parseAddArgs(['x', 'hello world', '--theme', 'launch', '--note', 'source: blog']);
  assert.strictEqual(draft.platform, 'x');
  assert.strictEqual(draft.text, 'hello world');
  assert.strictEqual(draft.status, 'draft');
  assert.strictEqual(draft.scheduledFor, null);
  assert.strictEqual(draft.theme, 'launch');
  assert.deepStrictEqual(draft.notes, ['source: blog']);

  const scheduled = parseAddArgs(['linkedin', 'my words', '--at', '2026-11-14 09:30']);
  assert.strictEqual(scheduled.status, 'scheduled');
  assert.strictEqual(scheduled.scheduledFor, new Date(2026, 10, 14, 9, 30).toISOString());

  const idea = parseAddArgs(['blog', 'an idea', '--idea']);
  assert.strictEqual(idea.status, 'idea');
});

test('parseAddArgs rejects bad input before any api call', () => {
  assert.ok(parseAddArgs([]).error);
  assert.ok(parseAddArgs(['myspace', 'hi']).error);
  assert.ok(parseAddArgs(['x']).error);
  assert.ok(parseAddArgs(['x', 'hi', '--at', 'soon']).error);
  assert.ok(parseAddArgs(['x', 'hi', '--at', '2026-11-14 09:30', '--draft']).error);
  assert.ok(parseAddArgs(['x', 'hi', '--bogus']).error);
});

test('resolvePostId takes exact or unique prefix, lists candidates when ambiguous', () => {
  assert.strictEqual(resolvePostId(posts, 'aaaa1111bbbb').id, 'aaaa1111bbbb');
  assert.strictEqual(resolvePostId(posts, 'dddd22').id, 'dddd2222eeee');
  const ambiguous = resolvePostId(posts, 'aaaa11');
  assert.ok(ambiguous.error);
  assert.strictEqual(ambiguous.candidates.length, 2);
  assert.ok(resolvePostId(posts, 'aa').error);
  assert.ok(resolvePostId(posts, 'zzzz99').error);
});

test('todayText renders sections and gap lines', () => {
  const text = todayText(todayBoard);
  assert.match(text, /going out/);
  assert.match(text, /launch day post/);
  assert.match(text, /post by hand/);
  assert.match(text, /reel caption/);
  assert.match(text, /failed/);
  assert.match(text, /X is not connected/);
  assert.match(text, /No LinkedIn post today\. You wanted 1\./);
  assert.match(text, /Blog: 1 of 1 this week\./);
  assert.match(text, /No TikTok post this week\. You wanted 2\./);
  assert.doesNotMatch(text, /em dash/);
});

test('todayText says so when the day is empty', () => {
  assert.match(todayText({}), /nothing on the calendar today/);
});

test('listText groups posts by day', () => {
  const text = listText(posts);
  assert.match(text, /launch day post/);
  assert.match(text, /a linkedin draft \(draft\)/);
  assert.match(text, /the long form piece/);
  assert.doesNotMatch(text, /\(posted\)|\(scheduled\)/);
  assert.match(listText([]), /no posts in this window/);
});

test('scoreText renders label and value over target', () => {
  const units = [
    { id: 'posts_x', label: 'X posts', kind: 'count', value: 12, target: 56, period: '28d', series: [], source: 'popshare', block: 'gauge' },
    { id: 'posts_blog', label: 'Blog posts', kind: 'count', value: 0, target: 4, period: '28d', series: [], source: 'popshare', block: 'gauge' },
  ];
  const text = scoreText(units);
  assert.match(text, /last 28 days/);
  assert.match(text, /X posts +12 \/ 56/);
  assert.match(text, /Blog posts +0 \/ 4/);
  assert.match(scoreText([]), /no platforms on the scoreboard yet/);
});

test('bare popshare reads today with the local timezone', async () => {
  const { code, out, calls } = await run([], { result: { ok: true, status: 200, data: todayBoard } });
  assert.strictEqual(code, 0);
  assert.strictEqual(calls.length, 1);
  assert.ok(calls[0].path.startsWith('/popshare/today?tz=UTC'));
  assert.match(out, /No LinkedIn post today/);
});

test('add posts the words the person wrote, nothing invented', async () => {
  const created = { id: 'newpost123', platform: 'x', status: 'scheduled', text: 'my words', scheduled_for: '2026-11-14T17:30:00.000Z' };
  const { code, out, calls } = await run(
    ['add', 'x', 'my words', '--at', '2026-11-14 09:30', '--theme', 'launch'],
    { result: { ok: true, status: 200, data: created } },
  );
  assert.strictEqual(code, 0);
  assert.strictEqual(calls[0].path, '/popshare/posts');
  assert.strictEqual(calls[0].options.method, 'POST');
  assert.strictEqual(calls[0].options.retries, 0);
  assert.strictEqual(calls[0].options.body.platform, 'x');
  assert.strictEqual(calls[0].options.body.text, 'my words');
  assert.strictEqual(calls[0].options.body.status, 'scheduled');
  assert.strictEqual(calls[0].options.body.scheduled_for, new Date(2026, 10, 14, 9, 30).toISOString());
  assert.strictEqual(calls[0].options.body.theme, 'launch');
  assert.match(out, /scheduled X newpost1 for \d{2}:\d{2}/);
});

test('schedule resolves a short id then patches status and time', async () => {
  const updated = { ...posts[0], status: 'scheduled', scheduled_for: '2026-11-15T17:30:00.000Z' };
  const { code, out, calls } = await run(['schedule', 'aaaa1111b', '--at', '2026-11-15 09:30'], {
    routes: [
      ['/popshare/posts?', { ok: true, status: 200, data: { posts } }],
      ['/popshare/posts/aaaa1111bbbb', { ok: true, status: 200, data: updated }],
    ],
  });
  assert.strictEqual(code, 0);
  assert.strictEqual(calls[0].path.startsWith('/popshare/posts?start='), true);
  assert.strictEqual(calls[1].path, '/popshare/posts/aaaa1111bbbb');
  assert.strictEqual(calls[1].options.method, 'PATCH');
  assert.strictEqual(calls[1].options.body.status, 'scheduled');
  assert.strictEqual(calls[1].options.body.scheduled_for, new Date(2026, 10, 15, 9, 30).toISOString());
  assert.match(out, /scheduled X aaaa1111/);
});

test('an ambiguous id prints candidates and stops', async () => {
  const { code, err, calls } = await run(['rm', 'aaaa11'], {
    routes: [['/popshare/posts?', { ok: true, status: 200, data: { posts } }]],
  });
  assert.strictEqual(code, 1);
  assert.match(err, /more than one post matches/);
  assert.match(err, /aaaa1111b/);
  assert.match(err, /aaaa1111c/);
  assert.strictEqual(calls.length, 1);
});

test('edit sends only the flags the person gave', async () => {
  const updated = { ...posts[1], text: 'better words', theme: 'launch' };
  const { code, calls } = await run(['edit', 'aaaa1111c', '--text', 'better words', '--theme', 'launch'], {
    routes: [
      ['/popshare/posts?', { ok: true, status: 200, data: { posts } }],
      ['/popshare/posts/aaaa1111cccc', { ok: true, status: 200, data: updated }],
    ],
  });
  assert.strictEqual(code, 0);
  const patch = calls.find((call) => call.options.method === 'PATCH');
  assert.deepStrictEqual(patch.options.body, { text: 'better words', theme: 'launch' });
});

test('edit --note appends to the notes already on the post', async () => {
  const withNotes = { ...posts[1], notes: ['first fact'] };
  const updated = { ...withNotes, notes: ['first fact', 'second fact'] };
  const { code, calls } = await run(['edit', 'aaaa1111c', '--note', 'second fact'], {
    routes: [
      ['/popshare/posts?', { ok: true, status: 200, data: { posts: [withNotes] } }],
      ['/popshare/posts/aaaa1111cccc', { ok: true, status: 200, data: updated }],
    ],
  });
  assert.strictEqual(code, 0);
  const patch = calls.find((call) => call.options.method === 'PATCH');
  assert.deepStrictEqual(patch.options.body.notes, ['first fact', 'second fact']);
});

test('post now calls publish once and prints the url', async () => {
  const posted = { ...posts[0], status: 'posted', posted_url: 'https://x.com/i/web/status/1' };
  const { code, out, calls } = await run(['post', 'aaaa1111b'], {
    routes: [
      ['/popshare/posts?', { ok: true, status: 200, data: { posts } }],
      ['/popshare/posts/aaaa1111bbbb/publish', { ok: true, status: 200, data: posted }],
    ],
  });
  assert.strictEqual(code, 0);
  const publish = calls.find((call) => call.path.endsWith('/publish'));
  assert.strictEqual(publish.options.method, 'POST');
  assert.strictEqual(publish.options.retries, 0);
  assert.match(out, /posted X aaaa1111 https:\/\/x\.com/);
});

test('a failed post now exits nonzero with the plain error', async () => {
  const failed = { ...posts[0], status: 'failed', error: 'X is not connected. Connect it in Atris, then try again.' };
  const { code, err } = await run(['post', 'aaaa1111b'], {
    routes: [
      ['/popshare/posts?', { ok: true, status: 200, data: { posts } }],
      ['/popshare/posts/aaaa1111bbbb/publish', { ok: true, status: 200, data: failed }],
    ],
  });
  assert.strictEqual(code, 1);
  assert.match(err, /X is not connected/);
});

test('posted marks a by-hand post with an optional url', async () => {
  const marked = { ...posts[2], posted_url: 'https://example.com/post' };
  const { code, calls } = await run(['posted', 'dddd22', '--url', 'https://example.com/post'], {
    routes: [
      ['/popshare/posts?', { ok: true, status: 200, data: { posts } }],
      ['/popshare/posts/dddd2222eeee/posted', { ok: true, status: 200, data: marked }],
    ],
  });
  assert.strictEqual(code, 0);
  const mark = calls.find((call) => call.path.endsWith('/posted'));
  assert.strictEqual(mark.options.method, 'POST');
  assert.deepStrictEqual(mark.options.body, { url: 'https://example.com/post' });
});

test('rm deletes the resolved post', async () => {
  const { code, out, calls } = await run(['rm', 'dddd22'], {
    routes: [
      ['/popshare/posts?', { ok: true, status: 200, data: { posts } }],
      ['/popshare/posts/dddd2222eeee', { ok: true, status: 200, data: { ok: true } }],
    ],
  });
  assert.strictEqual(code, 0);
  const del = calls.find((call) => call.options.method === 'DELETE');
  assert.strictEqual(del.path, '/popshare/posts/dddd2222eeee');
  assert.match(out, /removed dddd2222/);
});

test('score reads units over the weeks window', async () => {
  const units = [
    { id: 'posts_x', label: 'X posts', kind: 'count', value: 12, target: 56, period: '14d', source: 'popshare', block: 'gauge' },
  ];
  const { code, out, calls } = await run(['score', '--weeks', '2'], {
    result: { ok: true, status: 200, data: { units } },
  });
  assert.strictEqual(code, 0);
  assert.strictEqual(calls[0].path, '/popshare/scoreboard?days=14&tz=UTC');
  assert.match(out, /X posts +12 \/ 56/);
});

test('list reads the day window and prints grouped days', async () => {
  const { code, calls } = await run(['list', '--days', '14'], {
    result: { ok: true, status: 200, data: { posts } },
  });
  assert.strictEqual(code, 0);
  assert.ok(calls[0].path.startsWith('/popshare/posts?start='));
  assert.ok(calls[0].path.includes('end='));
});

test('--json prints one object', async () => {
  const { out } = await run(['--json'], { result: { ok: true, status: 200, data: todayBoard } });
  const parsed = JSON.parse(out);
  assert.strictEqual(parsed.ok, true);
  assert.ok(Array.isArray(parsed.gaps));
});

test('signed out asks for a login and calls nothing', async () => {
  const { code, err, calls } = await run([], { token: '' });
  assert.strictEqual(code, 1);
  assert.match(err, /atris login/);
  assert.strictEqual(calls.length, 0);
});

test('workspace scope rides along as business_id', async () => {
  const { calls } = await run(['--business', 'acme', 'score'], {
    result: { ok: true, status: 200, data: { units: [] } },
  });
  assert.ok(calls[0].path.includes('business_id=acme'));
});

test('install posts the business id', async () => {
  const { code, calls } = await run(['install', 'acme'], {
    result: { ok: true, status: 200, data: { app_id: 'app1' } },
  });
  assert.strictEqual(code, 0);
  assert.strictEqual(calls[0].path, '/popshare/install');
  assert.deepStrictEqual(calls[0].options.body, { business_id: 'acme' });
});
