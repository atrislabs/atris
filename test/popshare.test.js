'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
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
  kindForFile,
  mediaProblem,
  mediaTag,
  mediaItems,
  mediaFileName,
  multipartBody,
  uploadPostMedia,
  dayKey,
  parseLocalDate,
  parseWeekArgs,
  weekDays,
  weekDayKeys,
  postInstant,
  statusMark,
  gridPostLine,
  progressLine,
  weekText,
  showText,
  parseGoalsArgs,
  goalsText,
  parseStrategyArgs,
  strategyText,
  scorecardText,
  openInitialState,
  keyName,
  openReduce,
} = require('../commands/popshare');
const { displayWidth } = require('../lib/text-table');

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

async function run(args, { result, token = 'tok', routes, ask, httpRequest } = {}) {
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
    ...(httpRequest ? { httpRequest } : {}),
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

test('bare popshare reads the week plus today with the local timezone', async () => {
  const board = {
    scheduled_today: [],
    posted_today: [],
    due_by_hand: [],
    failed: [],
    check: [],
    gaps: [{ platform: 'x', wanted: 2, have: 0, period: 'day' }],
    goals: { x: 14, linkedin: 7, blog: 1, instagram: 2, tiktok: 2 },
    connections: {},
  };
  const { code, out, calls } = await run([], {
    routes: [
      ['/popshare/posts?', { ok: true, status: 200, data: { posts } }],
      ['/popshare/today', { ok: true, status: 200, data: board }],
    ],
  });
  assert.strictEqual(code, 0);
  assert.strictEqual(calls.length, 2);
  assert.ok(calls.some((call) => call.path.startsWith('/popshare/posts?start=')));
  assert.ok(calls.some((call) => call.path.startsWith('/popshare/today?tz=UTC')));
  assert.match(out, /week of/);
  assert.match(out, /today {2}X 0\/2/);
});

test('today still prints the old board', async () => {
  const { code, out, calls } = await run(['today'], { result: { ok: true, status: 200, data: todayBoard } });
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
  const { out } = await run(['today', '--json'], { result: { ok: true, status: 200, data: todayBoard } });
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

test('parseAddArgs collects repeatable --media files', () => {
  const parsed = parseAddArgs(['x', 'hi', '--media', 'a.png', '--media', 'clip.mp4']);
  assert.deepStrictEqual(parsed.media, ['a.png', 'clip.mp4']);
  assert.strictEqual(parseAddArgs(['x', 'hi']).media.length, 0);
  assert.ok(parseAddArgs(['x', 'hi', '--media']).error);
});

test('mediaTag renders picture and video markers on rows', () => {
  assert.strictEqual(mediaTag({ media: [{ kind: 'image' }] }), ' [1 picture]');
  assert.strictEqual(mediaTag({ media: [{ kind: 'image' }, { kind: 'image' }, { kind: 'image' }] }), ' [3 pictures]');
  assert.strictEqual(mediaTag({ media: [{ kind: 'video' }] }), ' [video]');
  assert.strictEqual(mediaTag({ media: [] }), '');
  assert.strictEqual(mediaTag({}), '');
  const withMedia = { ...posts[0], media: [{ path: 'files/popshare/x/a.png', kind: 'image', alt: '' }] };
  assert.match(todayText({ ...todayBoard, scheduled_today: [withMedia] }), /\[1 picture\]/);
  assert.match(listText([withMedia]), /\[1 picture\]/);
});

test('mediaProblem mirrors the backend rules', () => {
  const pics = Array.from({ length: 4 }, () => ({ kind: 'image', size: 10 }));
  assert.strictEqual(mediaProblem('x', pics), null);
  assert.ok(mediaProblem('x', [...pics, { kind: 'image', size: 1 }]));
  assert.ok(mediaProblem('x', [{ kind: 'video', size: 1 }, { kind: 'image', size: 1 }]));
  assert.ok(mediaProblem('x', [{ kind: 'image', size: 6 * 1024 * 1024 }]));
  assert.strictEqual(mediaProblem('instagram', [{ kind: 'image', size: 6 * 1024 * 1024 }]), null);
  assert.strictEqual(mediaProblem('x', [{ kind: 'video', size: 10 }]), null);
});

test('kindForFile and mediaItems clean up names and payloads', () => {
  assert.strictEqual(kindForFile('pic.PNG'), 'image');
  assert.strictEqual(kindForFile('clip.mov'), 'video');
  assert.strictEqual(kindForFile('notes.txt'), null);
  assert.strictEqual(mediaFileName('../My Pic (1).png').includes('/'), false);
  assert.deepStrictEqual(
    mediaItems([{ path: 'files/popshare/d/a.png', kind: 'image', alt: 'hi', size: 12, link: 'x' }]),
    [{ path: 'files/popshare/d/a.png', kind: 'image', alt: 'hi', size: 12 }],
  );
});

test('multipartBody puts every signed field before the file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'popshare-media-'));
  const file = path.join(dir, 'a.png');
  fs.writeFileSync(file, Buffer.from([1, 2, 3]));
  const { body, contentType } = multipartBody({ key: 'k', policy: 'p' }, file, 'a.png');
  const text = body.toString('latin1');
  assert.ok(contentType.startsWith('multipart/form-data; boundary='));
  assert.ok(text.indexOf('name="key"') < text.indexOf('name="file"'));
  assert.ok(text.includes('filename="a.png"'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('uploadPostMedia runs start, bucket POST, then done', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'popshare-media-'));
  const file = path.join(dir, 'pic.png');
  fs.writeFileSync(file, Buffer.from([9, 9, 9]));
  const apiCalls = [];
  const httpCalls = [];
  const result = await uploadPostMedia(file, 'post-1', {
    token: 'tok',
    apiRequestJson: async (p, options) => {
      apiCalls.push({ p, options });
      if (p === '/memory/upload') {
        return { ok: true, status: 200, data: { url: 'https://bucket.example/up', fields: { key: 'files/popshare/post-1/x.png' }, token: 'up-tok' } };
      }
      if (p === '/memory/upload/done') return { ok: true, status: 200, data: {} };
      return { ok: false, status: 404, data: {} };
    },
    httpRequest: async (url, options) => {
      httpCalls.push({ url, options });
      return { status: 204, headers: {}, body: Buffer.alloc(0) };
    },
  });
  assert.ok(result.item, JSON.stringify(result));
  assert.strictEqual(result.item.kind, 'image');
  assert.strictEqual(result.item.size, 3);
  assert.match(result.item.path, /^files\/popshare\/post-1\/.+-pic\.png$/);
  assert.deepStrictEqual(apiCalls.map((c) => c.p), ['/memory/upload', '/memory/upload/done']);
  assert.strictEqual(apiCalls[0].options.body.path, result.item.path);
  assert.strictEqual(apiCalls[1].options.body.token, 'up-tok');
  assert.strictEqual(httpCalls.length, 1);
  assert.strictEqual(httpCalls[0].url, 'https://bucket.example/up');
  assert.match(httpCalls[0].options.headers['Content-Type'], /^multipart\/form-data; boundary=/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('add --media uploads the file then saves media on the post', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'popshare-media-'));
  const file = path.join(dir, 'launch.png');
  fs.writeFileSync(file, Buffer.from([1, 2, 3, 4]));
  let created = null;
  const { code, calls } = await run(['add', 'x', 'launch words', '--media', file], {
    routes: [
      ['/memory/upload', (p, options) => options && options.method === 'POST' && !p.endsWith('/done')
        ? { ok: true, status: 200, data: { url: 'https://bucket.example/up', fields: { key: 'k' }, token: 'up-tok' } }
        : { ok: true, status: 200, data: {} }],
      ['/popshare/posts', { ok: true, status: 200, data: { id: 'aaaa1111bbbb', platform: 'x', status: 'draft', text: 'launch words' } }],
    ],
    httpRequest: async () => ({ status: 204, headers: {}, body: Buffer.alloc(0) }),
  });
  assert.strictEqual(code, 0);
  const postCall = calls.find((call) => call.path === '/popshare/posts' && call.options.method === 'POST');
  assert.ok(postCall, 'expected a create call');
  created = postCall.options.body;
  assert.strictEqual(created.media.length, 1);
  assert.strictEqual(created.media[0].kind, 'image');
  assert.match(created.media[0].path, /^files\/popshare\/.+\/.*-launch\.png$/);
  assert.strictEqual(created.media[0].size, 4);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('edit --clear-media sends an empty media list', async () => {
  const withMedia = { ...posts[0], media: [{ path: 'files/popshare/x/a.png', kind: 'image', alt: '' }] };
  const routes = [
    ['/popshare/posts?', { ok: true, status: 200, data: { posts: [withMedia] } }],
    ['/popshare/posts/aaaa1111bbbb', { ok: true, status: 200, data: withMedia }],
  ];
  const { code, calls } = await run(['edit', 'aaaa1111bbbb', '--clear-media'], { routes });
  assert.strictEqual(code, 0);
  const patch = calls.find((call) => call.path === '/popshare/posts/aaaa1111bbbb' && call.options.method === 'PATCH');
  assert.deepStrictEqual(patch.options.body.media, []);
});

// ------------------------------------------------------------------ week view

const at = (y, mo, d, h = 9, mi = 0) => new Date(y, mo - 1, d, h, mi).toISOString();
const WEEK_ANCHOR = new Date(2026, 10, 11, 12); // Wed Nov 11 2026, week Nov 9-15
const WEEK_BOARD = {
  scheduled_today: [],
  posted_today: [],
  due_by_hand: [],
  failed: [],
  check: [],
  gaps: [
    { platform: 'x', wanted: 2, have: 0, period: 'day' },
    { platform: 'linkedin', wanted: 1, have: 0, period: 'day' },
    { platform: 'blog', wanted: 1, have: 0, period: 'week' },
  ],
  goals: { x: 14, linkedin: 7, blog: 1, instagram: 2, tiktok: 0 },
  connections: {},
};
const weekPosts = [
  { id: 'mon00001aaa', platform: 'x', status: 'scheduled', text: 'mon words', scheduled_for: at(2026, 11, 9, 9, 0), created_at: at(2026, 11, 1) },
  { id: 'tue00002bbb', platform: 'linkedin', status: 'draft', text: 'tue words', created_at: at(2026, 11, 10, 8, 30) },
  { id: 'wed00003ccc', platform: 'blog', status: 'posted', title: 'wed piece', text: 'wed piece words', posted_at: at(2026, 11, 11, 18, 0), created_at: at(2026, 11, 5) },
  { id: 'fri00004ddd', platform: 'instagram', status: 'failed', text: 'fri reel', error: 'Instagram is not connected.', scheduled_for: at(2026, 11, 13, 12, 0), created_at: at(2026, 11, 12) },
];

test('weekDays starts Monday and keeps local midnights across DST', () => {
  const fall = weekDays(new Date(2026, 9, 28, 15)); // week Oct 26-Nov 1 holds the Nov 1 fall back
  assert.strictEqual(fall.length, 7);
  assert.strictEqual(fall[0].getDay(), 1);
  assert.strictEqual(fall[6].getDay(), 0);
  assert.deepStrictEqual(fall.map((d) => d.getDate()), [26, 27, 28, 29, 30, 31, 1]);
  fall.forEach((d) => assert.strictEqual(d.getHours(), 0));

  const spring = weekDays(new Date(2026, 2, 4, 15)); // week Mar 2-8 holds the Mar 8 spring forward
  assert.deepStrictEqual(spring.map((d) => d.getDate()), [2, 3, 4, 5, 6, 7, 8]);
  spring.forEach((d) => assert.strictEqual(d.getHours(), 0));
});

test('weekDayKeys lists the seven local days of a Monday week', () => {
  assert.deepStrictEqual(weekDayKeys('2026-11-09'), [
    '2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14', '2026-11-15',
  ]);
});

test('parseWeekArgs reads --next --prev --date and rejects the rest', () => {
  assert.ok(parseWeekArgs([]).anchor instanceof Date);
  assert.ok(parseWeekArgs(['--next']).anchor.getTime() > Date.now());
  assert.ok(parseWeekArgs(['--prev']).anchor.getTime() < Date.now());
  assert.strictEqual(dayKey(parseWeekArgs(['--date', '2026-11-14']).anchor), '2026-11-14');
  assert.ok(parseWeekArgs(['--date', 'soon']).error);
  assert.ok(parseWeekArgs(['--date']).error);
  assert.ok(parseWeekArgs(['--next', '--prev']).error);
  assert.ok(parseWeekArgs(['--next', '--date', '2026-11-14']).error);
  assert.ok(parseWeekArgs(['bogus']).error);
  assert.ok(parseWeekArgs(['--bogus']).error);
});

test('parseLocalDate and postInstant read local days and pick the calendar time', () => {
  assert.strictEqual(dayKey(parseLocalDate('2026-11-14')), '2026-11-14');
  assert.strictEqual(parseLocalDate('2026-02-31'), null);
  assert.strictEqual(parseLocalDate('14-11-2026'), null);
  const post = { scheduled_for: '2026-11-10T17:00:00Z', posted_at: '2026-11-09T17:00:00Z', created_at: '2026-11-01T00:00:00Z' };
  assert.strictEqual(postInstant(post).toISOString(), '2026-11-10T17:00:00.000Z');
  assert.strictEqual(postInstant({ posted_at: '2026-11-09T17:00:00Z', created_at: '2026-11-01T00:00:00Z' }).toISOString(), '2026-11-09T17:00:00.000Z');
  assert.strictEqual(postInstant({}), null);
});

test('statusMark and gridPostLine draw one compact cell', () => {
  assert.strictEqual(statusMark('scheduled'), '→');
  assert.strictEqual(statusMark('draft'), '·');
  assert.strictEqual(statusMark('posted'), '✓');
  assert.strictEqual(statusMark('imported'), '✓');
  assert.strictEqual(statusMark('failed'), '✗');
  const line = gridPostLine({ platform: 'x', status: 'scheduled', text: 'hello there', scheduled_for: at(2026, 11, 10, 9, 0) }, 13);
  assert.ok(displayWidth(line) <= 13);
  assert.match(line, /^9:00 X→ /);
});

test('weekText draws a seven-column grid that fits 100 columns', () => {
  const text = weekText(weekPosts, WEEK_BOARD, { anchor: WEEK_ANCHOR, width: 100, now: WEEK_ANCHOR });
  const lines = text.split('\n');
  for (const line of lines) assert.ok(displayWidth(line) <= 100, `line too wide: ${line}`);
  assert.match(text, /week of Nov 9 - Nov 15, 2026 · today Wed 11/);
  assert.match(text, /Mon 9 +Tue 10 +Wed 11\* +Thu 12 +Fri 13 +Sat 14 +Sun 15/);
  const colW = Math.floor((100 - 6) / 7);
  const row = lines.find((line) => line.includes('9:00') && line.includes('18:00'));
  assert.ok(row, 'expected a row with the monday and wednesday posts');
  const col = (index) => index * (colW + 1);
  for (const [index, stamp] of [[0, '9:00'], [1, '8:30'], [2, '18:00'], [4, '12:00']]) {
    const at = row.indexOf(stamp);
    assert.ok(at >= col(index) && at < col(index) + colW, `${stamp} should sit in column ${index}, found at ${at}`);
  }
});

test('weekText at 160 columns keeps lines inside the width and fuller snippets', () => {
  const text = weekText(weekPosts, WEEK_BOARD, { anchor: WEEK_ANCHOR, width: 160, now: WEEK_ANCHOR });
  const lines = text.split('\n');
  for (const line of lines) assert.ok(displayWidth(line) <= 160, `line too wide: ${line}`);
  const colW = Math.floor((160 - 6) / 7);
  const row = lines.find((line) => line.includes('wed piece'));
  assert.ok(row);
  const at = row.indexOf('wed piece');
  assert.ok(at >= 2 * (colW + 1) && at < 3 * (colW + 1) + colW);
});

test('weekText stacks day by day under 70 columns', () => {
  const text = weekText(weekPosts, WEEK_BOARD, { anchor: WEEK_ANCHOR, width: 60, now: WEEK_ANCHOR });
  const lines = text.split('\n');
  for (const line of lines) assert.ok(displayWidth(line) <= 60, `line too wide: ${line}`);
  assert.match(text, /Mon Nov 9\n/);
  assert.match(text, /Tue Nov 10\n/);
  assert.match(text, /Wed Nov 11 \(today\)\n/);
  assert.match(text, /Sun Nov 15\n/);
  assert.match(text, / {2}9:00 X→ mon/);
  assert.match(text, / {2}18:00 B✓ wed piece/);
});

test('progressLine renders the today and this week chips', () => {
  assert.strictEqual(
    progressLine(WEEK_BOARD),
    'today  X 0/2   LinkedIn 0/1      this week  Blog 0/1   Instagram ✓',
  );
  assert.strictEqual(progressLine({}), '');
  assert.strictEqual(progressLine({ goals: { x: 14 }, gaps: [] }), 'today  X ✓');
});

// ------------------------------------------------------------------ show

const shownPosted = {
  id: 'aaaa1111bbbb',
  platform: 'x',
  status: 'posted',
  text: 'launch day post',
  posted_url: 'https://x.com/i/web/status/1',
  posted_at: '2026-11-14T17:30:00.000Z',
  created_at: '2026-11-10T00:00:00Z',
  metrics: { like_count: 12, reply_count: 3, retweet_count: 2, quote_count: 1 },
  notes: ['Fact: I shipped it in a weekend. (journal.md:8)', 'Beat: The moment: "I shipped it"'],
  media: [{ path: 'files/popshare/x/pic.png', kind: 'image', alt: 'the launch visual', link: 'https://files.example/signed' }],
};

test('showText prints a posted post with link, media, engagement and notes', () => {
  const text = showText(shownPosted);
  assert.match(text, /X · posted · aaaa1111/);
  assert.match(text, /posted /);
  assert.match(text, /launch day post/);
  assert.match(text, /files\/popshare\/x\/pic\.png \(image\) "the launch visual" https:\/\/files\.example\/signed/);
  assert.match(text, /link: https:\/\/x\.com\/i\/web\/status\/1/);
  assert.match(text, /engagement: 12 likes, 3 replies, 2 reposts, 1 quote/);
  assert.match(text, /Fact: I shipped it in a weekend/);
  assert.match(text, /atris popshare rm aaaa1111/);
  assert.doesNotMatch(text, /error:/);
  assert.doesNotMatch(text, /atris popshare post aaaa1111/);
});

test('showText prints a failed post with its error and retry commands', () => {
  const post = {
    id: 'jkl000fffaaa',
    platform: 'x',
    status: 'failed',
    text: 'oops words',
    error: 'X is not connected. Connect it in Atris, then try again.',
    scheduled_for: at(2026, 11, 14, 9, 30),
    created_at: at(2026, 11, 13),
  };
  const text = showText(post);
  assert.match(text, /X · failed · jkl000ff/);
  assert.match(text, /scheduled for /);
  assert.match(text, /error: X is not connected/);
  assert.match(text, /atris popshare post jkl000ff/);
  assert.match(text, /atris popshare edit jkl000ff/);
});

test('showText prints a by-hand draft with the posted command', () => {
  const post = { id: 'aaaa1111cccc', platform: 'instagram', status: 'draft', text: 'reel words', created_at: at(2026, 11, 11, 10, 0) };
  const text = showText(post);
  assert.match(text, /Instagram · draft · aaaa1111/);
  assert.match(text, /saved /);
  assert.match(text, /atris popshare posted aaaa1111 --url/);
  assert.doesNotMatch(text, /atris popshare post aaaa1111/);
  assert.doesNotMatch(text, /error:/);
});

test('show resolves a short id and prints the post', async () => {
  const { code, out, calls } = await run(['show', 'aaaa1111b'], {
    routes: [['/popshare/posts?', { ok: true, status: 200, data: { posts: [shownPosted] } }]],
  });
  assert.strictEqual(code, 0);
  assert.ok(calls[0].path.startsWith('/popshare/posts?start=2000-01-01'));
  assert.match(out, /X · posted · aaaa1111/);
  assert.match(out, /launch day post/);
});

// ------------------------------------------------------------------ goals

test('parseGoalsArgs reads platform=count and rejects bad input', () => {
  assert.deepStrictEqual(parseGoalsArgs(['x=14', 'linkedin=7', 'tiktok=0']).goals, { x: 14, linkedin: 7, tiktok: 0 });
  assert.strictEqual(parseGoalsArgs([]).goals, null);
  assert.strictEqual(parseGoalsArgs(['twitter=3']).goals.x, 3);
  assert.ok(parseGoalsArgs(['myspace=3']).error);
  assert.ok(parseGoalsArgs(['x=-1']).error);
  assert.ok(parseGoalsArgs(['x=1.5']).error);
  assert.ok(parseGoalsArgs(['x']).error);
  assert.ok(parseGoalsArgs(['x=']).error);
  assert.ok(parseGoalsArgs(['--bogus']).error);
});

test('goalsText lists each platform goal', () => {
  const text = goalsText({ cadence_goals: { x: 14, linkedin: 7, blog: 1, instagram: 2, tiktok: 2 } });
  assert.match(text, /weekly goals/);
  assert.match(text, /X +14 a week/);
  assert.match(text, /LinkedIn +7 a week/);
  assert.match(text, /TikTok +2 a week/);
});

test('goals prints the saved weekly goals', async () => {
  const strategy = {
    narrative_arcs: [], cadence: '', audience: '', north_star: '',
    cadence_goals: { x: 14, linkedin: 7, blog: 1, instagram: 2, tiktok: 0 },
  };
  const { code, out, calls } = await run(['goals'], { result: { ok: true, status: 200, data: strategy } });
  assert.strictEqual(code, 0);
  assert.strictEqual(calls[0].path, '/popshare/strategy');
  assert.match(out, /X +14 a week/);
  assert.match(out, /TikTok +0 a week/);
});

test('goals x=3 merges into the strategy without touching other fields', async () => {
  const strategy = {
    narrative_arcs: ['launch'], cadence: 'daily', audience: 'founders', north_star: 'ship',
    cadence_goals: { x: 14, linkedin: 7, blog: 1, instagram: 2, tiktok: 2 },
  };
  let putBody = null;
  const { code, calls } = await run(['goals', 'x=3', 'tiktok=0'], {
    routes: [['/popshare/strategy', (p, options) => {
      if (options && options.method === 'PUT') {
        putBody = options.body;
        return { ok: true, status: 200, data: { ...strategy, cadence_goals: options.body.cadence_goals } };
      }
      return { ok: true, status: 200, data: strategy };
    }]],
  });
  assert.strictEqual(code, 0);
  assert.strictEqual(calls.length, 2);
  assert.strictEqual(calls[1].options.method, 'PUT');
  assert.strictEqual(putBody.narrative_arcs[0], 'launch');
  assert.strictEqual(putBody.cadence, 'daily');
  assert.strictEqual(putBody.audience, 'founders');
  assert.strictEqual(putBody.north_star, 'ship');
  assert.strictEqual(putBody.cadence_goals.x, 3);
  assert.strictEqual(putBody.cadence_goals.tiktok, 0);
  assert.strictEqual(putBody.cadence_goals.linkedin, 7);
});

// ------------------------------------------------------------------ week command

test('week fetches the Monday-Sunday window and prints the grid', async () => {
  const { code, out, calls } = await run(['week', '--date', '2026-11-11'], {
    routes: [
      ['/popshare/posts?', { ok: true, status: 200, data: { posts: weekPosts } }],
      ['/popshare/today', { ok: true, status: 200, data: WEEK_BOARD }],
    ],
  });
  assert.strictEqual(code, 0);
  const postsCall = calls.find((call) => call.path.startsWith('/popshare/posts?start='));
  assert.ok(postsCall);
  const params = new URLSearchParams(postsCall.path.split('?')[1]);
  assert.strictEqual(new Date(params.get('start')).getDay(), 1);
  assert.match(out, /week of Nov 9 - Nov 15, 2026/);
  assert.match(out, /today {2}X 0\/2/);
});

test('week --prev asks for the earlier Monday window', async () => {
  const { code, calls } = await run(['week', '--prev'], {
    routes: [
      ['/popshare/posts?', { ok: true, status: 200, data: { posts: [] } }],
      ['/popshare/today', { ok: true, status: 200, data: WEEK_BOARD }],
    ],
  });
  assert.strictEqual(code, 0);
  const postsCall = calls.find((call) => call.path.startsWith('/popshare/posts?start='));
  const params = new URLSearchParams(postsCall.path.split('?')[1]);
  const startDate = new Date(params.get('start'));
  const prevAnchor = new Date();
  prevAnchor.setDate(prevAnchor.getDate() - 7);
  assert.strictEqual(dayKey(startDate), dayKey(weekDays(prevAnchor)[0]));
});

test('open prints the week when there is no terminal', async () => {
  const { code, out, calls } = await run(['open'], {
    routes: [
      ['/popshare/posts?', { ok: true, status: 200, data: { posts: weekPosts } }],
      ['/popshare/today', { ok: true, status: 200, data: WEEK_BOARD }],
    ],
  });
  assert.strictEqual(code, 0);
  assert.strictEqual(calls.length, 2);
  assert.match(out, /week of/);
});

// ------------------------------------------------------------------ open reducer

const xScheduledPost = { id: 'x1sched00', platform: 'x', status: 'scheduled', text: 'x words' };
const liDraftPost = { id: 'l1draft00', platform: 'linkedin', status: 'draft', text: 'li words' };
const igScheduledPost = { id: 'i1sched00', platform: 'instagram', status: 'scheduled', text: 'ig words' };
const xPostedPost = { id: 'xpost0000', platform: 'x', status: 'posted', text: 'posted words' };

function openView(dayPosts, todayKey = '2026-11-11') {
  return {
    todayKey,
    board: {},
    days: weekDays(WEEK_ANCHOR).map((date, index) => ({
      date,
      key: dayKey(date),
      isToday: dayKey(date) === todayKey,
      posts: (dayPosts && dayPosts[index]) || [],
    })),
  };
}

const OPEN_VIEW = openView([[], [], [xScheduledPost], [], [liDraftPost, igScheduledPost], [], []]);
const OPEN_STATE = () => openInitialState(WEEK_ANCHOR, '2026-11-11');

test('openInitialState lands on today inside the current week', () => {
  const state = OPEN_STATE();
  assert.strictEqual(state.week, '2026-11-09');
  assert.strictEqual(state.day, 2);
  assert.strictEqual(state.view, 'grid');
  const other = openInitialState(new Date(2026, 10, 20, 12), '2026-11-11');
  assert.strictEqual(other.day, 0);
});

test('keyName normalizes arrows, return and ctrl-c', () => {
  assert.strictEqual(keyName('', { name: 'left' }), 'left');
  assert.strictEqual(keyName('', { name: 'up' }), 'up');
  assert.strictEqual(keyName('', { name: 'return' }), 'return');
  assert.strictEqual(keyName('q', { name: 'q' }), 'q');
  assert.strictEqual(keyName(']', {}), ']');
  assert.strictEqual(keyName('', { name: 'c', ctrl: true }), 'ctrl-c');
});

test('openReduce moves the day selection and clamps at the week edges', () => {
  const view = OPEN_VIEW;
  let state = OPEN_STATE();
  let r = openReduce(state, 'right', view);
  assert.strictEqual(r.state.day, 3);
  assert.strictEqual(r.state.post, 0);
  r = openReduce(r.state, 'left', view);
  assert.strictEqual(r.state.day, 2);
  state = { ...r.state, day: 0 };
  r = openReduce(state, 'left', view);
  assert.strictEqual(r.state.day, 0);
  state = { ...r.state, day: 6 };
  r = openReduce(state, 'right', view);
  assert.strictEqual(r.state.day, 6);
});

test('openReduce moves between posts in a day and wraps weeks', () => {
  const view = OPEN_VIEW;
  let state = OPEN_STATE();
  state = openReduce(state, 'right', view).state;
  state = openReduce(state, 'right', view).state;
  assert.strictEqual(state.day, 4);
  let r = openReduce(state, 'down', view);
  assert.strictEqual(r.state.post, 1);
  r = openReduce(r.state, 'down', view);
  assert.strictEqual(r.state.post, 1);
  r = openReduce(r.state, 'up', view);
  assert.strictEqual(r.state.post, 0);
  r = openReduce(state, ']', view);
  assert.strictEqual(r.state.week, '2026-11-16');
  assert.strictEqual(r.state.day, 0);
  r = openReduce(r.state, '[', view);
  assert.strictEqual(r.state.week, '2026-11-09');
  assert.strictEqual(r.state.day, 2);
});

test('openReduce enter opens a post and return closes it', () => {
  const view = OPEN_VIEW;
  const state = OPEN_STATE();
  let r = openReduce(state, 'enter', view);
  assert.strictEqual(r.state.view, 'detail');
  r = openReduce(r.state, 'return', view);
  assert.strictEqual(r.state.view, 'grid');
  const empty = { ...state, day: 1 };
  r = openReduce(empty, 'enter', view);
  assert.strictEqual(r.state.view, 'grid');
  assert.match(r.state.note, /no posts/);
});

test('openReduce p asks before posting and y confirms', () => {
  const view = OPEN_VIEW;
  const state = OPEN_STATE();
  let r = openReduce(state, 'p', view);
  assert.strictEqual(r.state.view, 'confirm');
  assert.strictEqual(r.action, null);
  r = openReduce(r.state, 'y', view);
  assert.deepStrictEqual(r.action, { type: 'post-now', day: 2, post: 0 });
  assert.strictEqual(r.state.view, 'grid');
  r = openReduce(state, 'p', view);
  r = openReduce(r.state, 'n', view);
  assert.strictEqual(r.state.view, 'grid');
  assert.strictEqual(r.action, null);
});

test('openReduce p refuses by-hand and posted posts with a note', () => {
  const view = OPEN_VIEW;
  let state = OPEN_STATE();
  state = openReduce(state, 'right', view).state;
  state = openReduce(state, 'right', view).state;
  let r = openReduce(state, 'p', view); // linkedin draft confirms
  assert.strictEqual(r.state.view, 'confirm');
  state = { ...r.state, view: 'grid', confirmPost: null };
  state = openReduce(state, 'down', view).state; // instagram scheduled
  r = openReduce(state, 'p', view);
  assert.strictEqual(r.state.view, 'grid');
  assert.match(r.state.note, /by hand/);

  const postedView = openView([[], [], [xPostedPost], [], [], [], []]);
  const postedState = OPEN_STATE();
  r = openReduce(postedState, 'p', postedView);
  assert.strictEqual(r.state.view, 'grid');
  assert.match(r.state.note, /already posted/);
});

test('openReduce action keys map to board actions', () => {
  const view = OPEN_VIEW;
  const state = OPEN_STATE();
  assert.deepStrictEqual(openReduce(state, 'e', view).action, { type: 'edit-post', day: 2, post: 0 });
  assert.deepStrictEqual(openReduce(state, 's', view).action, { type: 'schedule-post', day: 2, post: 0 });
  assert.deepStrictEqual(openReduce(state, 'i', view).action, { type: 'interview-post', day: 2, post: 0 });
  assert.deepStrictEqual(openReduce(state, 'n', view).action, { type: 'new-post', day: '2026-11-11' });
  assert.deepStrictEqual(openReduce(state, 'r', view).action, { type: 'refresh' });
  assert.strictEqual(openReduce(state, 'q', view).action.type, 'quit');
  assert.strictEqual(openReduce(state, 'ctrl-c', view).action.type, 'quit');
});

test('openReduce refuses edits on posted posts and ? toggles help', () => {
  const postedView = openView([[], [], [xPostedPost], [], [], [], []]);
  const state = OPEN_STATE();
  const r = openReduce(state, 'e', postedView);
  assert.strictEqual(r.state.view, 'grid');
  assert.match(r.state.note, /read only/);

  const view = OPEN_VIEW;
  let help = openReduce(state, '?', view);
  assert.strictEqual(help.state.view, 'help');
  help = openReduce(help.state, 'x', view);
  assert.strictEqual(help.state.view, 'grid');
  help = openReduce(state, '?', view);
  help = openReduce(help.state, '?', view);
  assert.strictEqual(help.state.view, 'grid');
});

// ------------------------------------------------------------------ tie_id, strategy, scorecard, scoreboard

test('add --tie sends tie_id and rejects missing or empty --tie', async () => {
  const parsed = parseAddArgs(['x', 'swarm thread', '--tie', '  can-you-feel-the-swarm  ']);
  assert.strictEqual(parsed.tieId, 'can-you-feel-the-swarm');
  assert.ok(parseAddArgs(['x', 'hi', '--tie']).error);
  assert.ok(parseAddArgs(['x', 'hi', '--tie', '   ']).error);

  const { code, calls } = await run(['add', 'x', 'swarm thread', '--tie', 'can-you-feel-the-swarm'], {
    result: {
      ok: true,
      status: 200,
      data: { id: 'p1234567', platform: 'x', status: 'draft', text: 'swarm thread', tie_id: 'can-you-feel-the-swarm' },
    },
  });
  assert.strictEqual(code, 0);
  assert.strictEqual(calls[0].options.body.tie_id, 'can-you-feel-the-swarm');
});

test('edit --tie and --clear-tie patch tie_id cleanly', async () => {
  const existing = { id: 'aaaa1111bbbb', platform: 'linkedin', status: 'draft', text: 'li post' };
  const setRes = await run(['edit', 'aaaa11', '--tie', 'can-you-feel-the-swarm'], {
    routes: [
      ['/popshare/posts?', { ok: true, status: 200, data: { posts: [existing] } }],
      ['/popshare/posts/aaaa1111bbbb', { ok: true, status: 200, data: { ...existing, tie_id: 'can-you-feel-the-swarm' } }],
    ],
  });
  assert.strictEqual(setRes.code, 0);
  assert.strictEqual(setRes.calls[1].options.body.tie_id, 'can-you-feel-the-swarm');

  const clearRes = await run(['edit', 'aaaa11', '--clear-tie'], {
    routes: [
      ['/popshare/posts?', { ok: true, status: 200, data: { posts: [existing] } }],
      ['/popshare/posts/aaaa1111bbbb', { ok: true, status: 200, data: { ...existing, tie_id: null } }],
    ],
  });
  assert.strictEqual(clearRes.code, 0);
  assert.strictEqual(clearRes.calls[1].options.body.tie_id, '');
});

test('list --tie passes tie_id query param and showText prints tie', async () => {
  const tied = { id: 'aaaa1111bbbb', platform: 'x', status: 'draft', text: 'swarm post', tie_id: 'can-you-feel-the-swarm' };
  assert.match(showText(tied), /tie: can-you-feel-the-swarm/);

  const { code, out, calls } = await run(['list', '--tie', 'can-you-feel-the-swarm', '--json'], {
    result: { ok: true, status: 200, data: { posts: [tied] } },
  });
  assert.strictEqual(code, 0);
  assert.strictEqual(calls[0].path, '/popshare/posts?tie_id=can-you-feel-the-swarm');
  const payload = JSON.parse(out);
  assert.strictEqual(payload.ok, true);
  assert.strictEqual(payload.posts[0].tie_id, 'can-you-feel-the-swarm');
});

test('interview --new --tie forwards tie_id', async () => {
  const parsed = parseInterviewArgs(['--new', 'linkedin', 'swarm lessons', '--tie', 'can-you-feel-the-swarm']);
  assert.strictEqual(parsed.tieId, 'can-you-feel-the-swarm');

  const { code, calls } = await run(['interview', '--new', 'linkedin', 'swarm lessons', '--tie', 'can-you-feel-the-swarm'], {
    routes: [
      ['/popshare/interview', {
        ok: true,
        status: 200,
        data: {
          post: { id: 'int123', platform: 'linkedin', tie_id: 'can-you-feel-the-swarm' },
          session: { status: 'done', topic: 'swarm lessons', outline: ['beat 1'] },
        },
      }],
    ],
  });
  assert.strictEqual(code, 0);
  assert.strictEqual(calls[0].options.body.tie_id, 'can-you-feel-the-swarm');
});

test('strategy prints and updates fields without dropping existing values', async () => {
  const saved = {
    north_star: 'earn inbound trust',
    audience: 'builders',
    cadence: 'daily x, 3x linkedin',
    narrative_arcs: ['Founder lessons', 'Swarm builds'],
    cadence_goals: { x: 14, linkedin: 7, blog: 1, instagram: 0, tiktok: 0 },
  };
  assert.match(strategyText(saved), /north star: earn inbound trust/);
  assert.match(strategyText(saved), /- Founder lessons/);
  assert.ok(parseStrategyArgs(['--arc', 'a', '--clear-arcs']).error);

  const view = await run(['strategy', '--json'], {
    result: { ok: true, status: 200, data: saved },
  });
  assert.strictEqual(view.code, 0);
  assert.strictEqual(JSON.parse(view.out).strategy.north_star, 'earn inbound trust');

  let putBody = null;
  const update = await run(['strategy', '--north-star', '100x compounding', '--arc', 'Ship logs', 'x=10'], {
    routes: [['/popshare/strategy', (_p, options) => {
      if (options && options.method === 'PUT') {
        putBody = options.body;
        return { ok: true, status: 200, data: options.body };
      }
      return { ok: true, status: 200, data: saved };
    }]],
  });
  assert.strictEqual(update.code, 0);
  assert.strictEqual(putBody.north_star, '100x compounding');
  assert.strictEqual(putBody.audience, 'builders');
  assert.strictEqual(putBody.cadence, 'daily x, 3x linkedin');
  assert.deepStrictEqual(putBody.narrative_arcs, ['Ship logs']);
  assert.strictEqual(putBody.cadence_goals.x, 10);
  assert.strictEqual(putBody.cadence_goals.linkedin, 7);
});

test('scorecard renders connections, totals, ties, and supports --tie and --json', async () => {
  const sample = {
    connected: true,
    connections: { x: 'ok', linkedin: 'ok' },
    totals: {
      posts: 2,
      arc_match_rate: 1,
      metrics: { like_count: 25, comment_count: 4 },
      by_platform: {
        x: { posts: 1, metrics: { like_count: 10 } },
        linkedin: { posts: 1, metrics: { like_count: 15, comment_count: 4 } },
      },
    },
    ties: [
      {
        tie_id: 'can-you-feel-the-swarm',
        posts: 2,
        platforms: ['linkedin', 'x'],
        metrics: { like_count: 25, comment_count: 4 },
      },
    ],
    by_tie: {
      'can-you-feel-the-swarm': {
        tie_id: 'can-you-feel-the-swarm',
        posts: 2,
        platforms: ['linkedin', 'x'],
        metrics: { like_count: 25, comment_count: 4 },
      },
    },
    posts: [
      { id: 'p1', platform: 'x', tie_id: 'can-you-feel-the-swarm', text_snippet: 'swarm tweet', arc_matched: 'Swarm builds', metrics: { like_count: 10 } },
      { id: 'p2', platform: 'linkedin', tie_id: 'other-tie', text_snippet: 'other post', metrics: { like_count: 15 } },
    ],
  };

  const rendered = scorecardText(sample);
  assert.match(rendered, /connections: X: ok, LinkedIn: ok/);
  assert.match(rendered, /scorecard: 2 posts, 100% on arc/);
  assert.match(rendered, /can-you-feel-the-swarm \(linkedin, x\)/);
  assert.match(rendered, /X \[can-you-feel-the-swarm\] \(Swarm builds\): swarm tweet/);

  const res = await run(['scorecard', '--tie', 'can-you-feel-the-swarm', '--json'], {
    result: { ok: true, status: 200, data: sample },
  });
  assert.strictEqual(res.code, 0);
  assert.strictEqual(res.calls[0].path, '/popshare/scorecard');
  const jsonOut = JSON.parse(res.out);
  assert.strictEqual(jsonOut.tie_id, 'can-you-feel-the-swarm');
  assert.strictEqual(jsonOut.ties.length, 1);
  assert.strictEqual(jsonOut.posts.length, 1);
  assert.strictEqual(jsonOut.posts[0].id, 'p1');
});

test('scoreboard aliases score against /popshare/scoreboard', async () => {
  const units = [{ id: 'x', label: 'X', period: '28d', value: 4, target: 14 }];
  const { code, out, calls } = await run(['scoreboard', '--weeks', '2', '--json'], {
    result: { ok: true, status: 200, data: { units } },
  });
  assert.strictEqual(code, 0);
  assert.strictEqual(calls[0].path, '/popshare/scoreboard?days=14&tz=UTC');
  const payload = JSON.parse(out);
  assert.strictEqual(payload.ok, true);
  assert.strictEqual(payload.units[0].value, 4);
});
