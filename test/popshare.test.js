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
  parseInterviewArgs,
  sessionOpenQuestion,
  interviewContextText,
  interviewDoneText,
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

async function run(args, { result, token = 'tok', routes, ask } = {}) {
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
    ...(ask ? { ask } : {}),
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

test('todayText prints connection lines at the top', () => {
  const text = todayText({
    ...todayBoard,
    connections: { x: 'reconnect', linkedin: 'missing' },
    goals: { x: 14, linkedin: 7, blog: 1, instagram: 0, tiktok: 0 },
  });
  assert.match(text, /X needs a fresh connection\. Reconnect it so scheduled posts go out and your tweets count\./);
  assert.match(text, /LinkedIn isn't connected\. Connect it so scheduled posts go out\./);
  assert.ok(text.indexOf('X needs a fresh connection') < text.indexOf('going out'));
  assert.ok(text.indexOf("LinkedIn isn't connected") < text.indexOf('going out'));
});

test('todayText stays quiet for ok connections or platforms without a goal', () => {
  const ok = todayText({ ...todayBoard, connections: { x: 'ok', linkedin: 'ok' }, goals: { x: 14, linkedin: 7 } });
  assert.doesNotMatch(ok, /fresh connection/);
  assert.doesNotMatch(ok, /isn't connected/);

  const noGoal = todayText({
    scheduled_today: [],
    posted_today: [],
    due_by_hand: [],
    failed: [],
    check: [],
    gaps: [],
    connections: { linkedin: 'missing' },
    goals: { linkedin: 0 },
  });
  assert.doesNotMatch(noGoal, /LinkedIn isn't connected/);

  const scheduledOnly = todayText({
    scheduled_today: [{ id: 's1', platform: 'linkedin', status: 'scheduled', text: 'words', scheduled_for: '2026-11-14T10:00:00Z' }],
    posted_today: [],
    due_by_hand: [],
    failed: [],
    check: [],
    gaps: [],
    connections: { linkedin: 'missing' },
    goals: { linkedin: 0 },
  });
  assert.match(scheduledOnly, /LinkedIn isn't connected\. Connect it so scheduled posts go out\./);
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

// ---------------------------------------------------------------- interview

const sessionAsking = {
  post_id: 'aaaa1111bbbb',
  platform: 'x',
  topic: 'why I built Popshare',
  status: 'asking',
  questions: [{ q: 'What happened, in your own words?', a: null }],
  facts: [{ text: 'I shipped it in a weekend.', source: 'journal.md:8' }],
  style: ['Short sentences. No jargon.'],
  outline: [],
  research: false,
};

const sessionDone = {
  ...sessionAsking,
  status: 'done',
  questions: [{ q: 'What happened, in your own words?', a: 'I shipped it in a weekend.' }],
  outline: [{ beat: 'The moment', quote: 'I shipped it in a weekend.' }],
};

test('parseInterviewArgs reads --new and resume forms', () => {
  const fresh = parseInterviewArgs(['--new', 'x', 'why I built it', '--research']);
  assert.strictEqual(fresh.mode, 'new');
  assert.strictEqual(fresh.platform, 'x');
  assert.strictEqual(fresh.topic, 'why I built it');
  assert.strictEqual(fresh.research, true);

  const resume = parseInterviewArgs(['aaaa1111b']);
  assert.strictEqual(resume.mode, 'resume');
  assert.strictEqual(resume.idInput, 'aaaa1111b');

  assert.ok(parseInterviewArgs([]).error);
  assert.ok(parseInterviewArgs(['--new']).error);
  assert.ok(parseInterviewArgs(['--new', 'myspace', 'hi']).error);
  assert.ok(parseInterviewArgs(['--new', 'x']).error);
  assert.ok(parseInterviewArgs(['aaaa1111b', '--bogus']).error);
});

test('sessionOpenQuestion finds the unanswered one', () => {
  assert.deepStrictEqual(sessionOpenQuestion(sessionAsking), { index: 0, text: 'What happened, in your own words?' });
  const mid = {
    questions: [
      { q: 'first?', a: 'done' },
      { q: 'second?', a: null },
      { q: 'third?', a: 'also done' },
    ],
  };
  assert.deepStrictEqual(sessionOpenQuestion(mid), { index: 1, text: 'second?' });
  assert.strictEqual(sessionOpenQuestion(sessionDone), null);
  assert.strictEqual(sessionOpenQuestion({}), null);
});

test('interviewContextText prints facts and voice, skips empty sections', () => {
  const text = interviewContextText(sessionAsking);
  assert.match(text, /interview for "why I built Popshare"/);
  assert.match(text, /what I know:\n {2}- I shipped it in a weekend\. \(journal\.md:8\)/);
  assert.match(text, /how you write:\n {2}- Short sentences\. No jargon\./);
  const bare = interviewContextText({ topic: 't', facts: [], style: [] });
  assert.strictEqual(bare, 'interview for "t"');
});

test('interviewDoneText prints beats and the edit hint', () => {
  const text = interviewDoneText(sessionDone, 'aaaa1111bbbb');
  assert.match(text, /outline:/);
  assert.match(text, /The moment: "I shipped it in a weekend\."/);
  assert.match(text, /now write it: atris popshare edit aaaa1111 --text "\.\.\."/);
});

test('interview --new posts platform topic research then walks the questions', async () => {
  const answers = ['I built it after the third time I lost track.', 'mostly founders'];
  const ask = async () => (answers.length ? answers.shift() : null);
  const routes = [
    ['/popshare/interview', {
      ok: true, status: 200,
      data: {
        post: { id: 'aaaa1111bbbb', platform: 'x', status: 'idea', text: '', theme: 'why I built Popshare' },
        session: sessionAsking,
      },
    }],
    ['/popshare/posts/aaaa1111bbbb/interview/answer', (path, options) => {
      const body = options.body;
      if (body.answer === 'I built it after the third time I lost track.') {
        return {
          ok: true, status: 200,
          data: {
            ...sessionAsking,
            questions: [
              { q: 'What happened, in your own words?', a: body.answer },
              { q: 'Who is it for?', a: null },
            ],
          },
        };
      }
      return { ok: true, status: 200, data: sessionDone };
    }],
  ];
  const { code, out, calls } = await run(['interview', '--new', 'x', 'why I built Popshare'], { routes, ask });
  assert.strictEqual(code, 0);
  const create = calls.find((call) => call.path === '/popshare/interview');
  assert.strictEqual(create.options.method, 'POST');
  assert.deepStrictEqual(create.options.body, { platform: 'x', topic: 'why I built Popshare', research: false });
  assert.match(out, /interview for "why I built Popshare"/);
  assert.match(out, /I shipped it in a weekend\. \(journal\.md:8\)/);
  assert.match(out, /Q1: What happened, in your own words\?/);
  assert.match(out, /Q2: Who is it for\?/);
  assert.match(out, /The moment: "I shipped it in a weekend\."/);
  assert.match(out, /now write it: atris popshare edit aaaa1111 --text "\.\.\."/);
  const answerCalls = calls.filter((call) => call.path.endsWith('/interview/answer'));
  assert.strictEqual(answerCalls.length, 2);
  assert.strictEqual(answerCalls[0].options.body.answer, 'I built it after the third time I lost track.');
});

test('interview <id> resumes an existing session and starts one on 404', async () => {
  const answers = ['my answer'];
  const ask = async () => (answers.length ? answers.shift() : null);
  const routes = [
    ['/popshare/posts?', { ok: true, status: 200, data: { posts } }],
    // The answer path also starts with the interview prefix, so it comes first.
    ['/popshare/posts/aaaa1111bbbb/interview/answer', { ok: true, status: 200, data: sessionDone }],
    ['/popshare/posts/aaaa1111bbbb/interview', (path, options) => {
      if (options && options.method === 'GET') {
        return { ok: false, status: 404, error: 'No interview for that post.' };
      }
      return { ok: true, status: 200, data: sessionAsking };
    }],
  ];
  const { code, calls } = await run(['interview', 'aaaa1111b'], { routes, ask });
  assert.strictEqual(code, 0);
  const get = calls.find((call) => call.path === '/popshare/posts/aaaa1111bbbb/interview' && call.options.method === 'GET');
  assert.ok(get);
  const start = calls.find((call) => call.path === '/popshare/posts/aaaa1111bbbb/interview' && call.options.method === 'POST');
  assert.ok(start);
  assert.deepStrictEqual(start.options.body, { research: false });
});

test('interview <id> uses a live session without restarting it', async () => {
  const ask = async () => 'an answer';
  const routes = [
    ['/popshare/posts?', { ok: true, status: 200, data: { posts } }],
    ['/popshare/posts/aaaa1111bbbb/interview', (path, options) => {
      if (options && options.method === 'POST' && path.endsWith('/answer')) {
        return { ok: true, status: 200, data: sessionDone };
      }
      return { ok: true, status: 200, data: sessionAsking };
    }],
  ];
  const { code, calls } = await run(['interview', 'aaaa1111b'], { routes, ask });
  assert.strictEqual(code, 0);
  const interviewCalls = calls.filter((call) => call.path === '/popshare/posts/aaaa1111bbbb/interview');
  assert.strictEqual(interviewCalls.length, 1);
  assert.strictEqual(interviewCalls[0].options.method, 'GET');
});

test('a null answer pauses the interview and keeps the session', async () => {
  const ask = async () => null;
  const routes = [
    ['/popshare/interview', {
      ok: true, status: 200,
      data: { post: { id: 'aaaa1111bbbb' }, session: sessionAsking },
    }],
  ];
  const { code, out, calls } = await run(['interview', '--new', 'x', 'topic'], { routes, ask });
  assert.strictEqual(code, 0);
  assert.match(out, /paused\. run the same command again/);
  assert.strictEqual(calls.filter((call) => call.path.includes('/answer')).length, 0);
});

test('empty answers re-ask without spending a question', async () => {
  const answers = ['', 'real answer'];
  const ask = async () => answers.shift();
  const routes = [
    ['/popshare/interview', {
      ok: true, status: 200,
      data: { post: { id: 'aaaa1111bbbb' }, session: sessionAsking },
    }],
    ['/popshare/posts/aaaa1111bbbb/interview/answer', { ok: true, status: 200, data: sessionDone }],
  ];
  const { code, out, calls } = await run(['interview', '--new', 'x', 'topic'], { routes, ask });
  assert.strictEqual(code, 0);
  assert.match(out, /empty answer skipped/);
  assert.strictEqual(calls.filter((call) => call.path.includes('/answer')).length, 1);
});

test('interview api errors surface plainly', async () => {
  const { code, err } = await run(['interview', '--new', 'x', 'topic'], {
    result: { ok: false, status: 409, error: 'That post already went out.' },
    ask: async () => 'x',
  });
  assert.strictEqual(code, 1);
  assert.match(err, /already went out/);
});
