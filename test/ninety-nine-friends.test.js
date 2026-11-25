'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { ninetyNineAtris } = require('../commands/ninety-nine');

const cli = path.resolve(__dirname, '../bin/atris.js');

// A fake 99 server: each answer is looked up by "METHOD /path" and the calls are kept.
function fixture(answers, { token = 'tok-123', time = new Date(2026, 10, 24, 12, 0, 0) } = {}) {
  const calls = [];
  const request = async (pathname, options) => {
    const url = new URL(pathname, 'https://mock.invalid');
    calls.push({ method: options.method, path: url.pathname, query: Object.fromEntries(url.searchParams), token: options.token });
    const answer = answers[`${options.method} ${url.pathname}`];
    if (answer instanceof Error) throw answer;
    return answer ?? { ok: false, status: 404, data: { detail: { code: 'not_found', message: 'Nothing here' } } };
  };
  return {
    calls,
    async run(...args) {
      const lines = [];
      const code = await ninetyNineAtris(args, {
        log: (line) => lines.push(line), request, now: () => time, interactive: false,
        credentials: () => (token ? { token } : null),
      });
      return { code, output: lines.join('\n') };
    },
  };
}

const ok = (data) => ({ ok: true, status: 200, data });
const failure = (status, code, message) => ({ ok: false, status, data: { detail: { code, message } } });
const link = 'https://atris.ai/app/99/join/abcdefghjk';
const entry = (rank, name, score, streak, extra = {}) => ({
  rank, username: name.toLowerCase(), display_name: name, avatar_url: null, score, streak, ...extra,
});

test('invite prints the link and the friend count', async () => {
  const f = fixture({ 'GET /99/invite': ok({ code: 'abcdefghjk', url: link, friends: 2 }) });
  assert.deepEqual(await f.run('invite'), { code: 0, output: `Send this link to a friend:\n${link}\nYou have 2 friends.` });
  assert.deepEqual(f.calls, [{ method: 'GET', path: '/99/invite', query: {}, token: 'tok-123' }]);
  const none = fixture({ 'GET /99/invite': ok({ code: 'abcdefghjk', url: link, friends: 0 }) });
  assert.match((await none.run('invite')).output, /\nNo friends yet\.$/);
  const one = fixture({ 'GET /99/invite': ok({ code: 'abcdefghjk', url: link, friends: 1 }) });
  assert.match((await one.run('invite')).output, /\nYou have 1 friend\.$/);
});

test('invite --json prints exactly what the server sent', async () => {
  const data = { code: 'abcdefghjk', url: link, friends: 3 };
  const f = fixture({ 'GET /99/invite': ok(data) });
  assert.deepEqual(await f.run('invite', '--json'), { code: 0, output: JSON.stringify(data) });
});

test('join takes a bare code, the web link or the phone link', async () => {
  const answer = ok({ friend: { id: 'u2', username: 'maya', display_name: 'Maya Chen', avatar_url: null }, friends: 3, already: false });
  for (const given of ['abcdefghjk', 'ABCDEFGHJK', link, `${link}/`, `${link}?ref=text`, 'project99://join/abcdefghjk', '  abcdefghjk  ']) {
    const f = fixture({ 'POST /99/invite/abcdefghjk/accept': answer });
    assert.deepEqual(await f.run('join', given), {
      code: 0,
      output: 'You and Maya Chen are friends now.\nYou have 3 friends.\nSee the board: atris 99 board --friends',
    }, given);
    assert.deepEqual(f.calls.map((call) => [call.method, call.path, call.token]), [['POST', '/99/invite/abcdefghjk/accept', 'tok-123']]);
  }
});

test('join says so when they were already friends, and prints json when asked', async () => {
  const data = { friend: { id: 'u2', username: 'maya', display_name: null, avatar_url: null }, friends: 1, already: true };
  const f = fixture({ 'POST /99/invite/abcdefghjk/accept': ok(data) });
  assert.deepEqual(await f.run('join', link), {
    code: 0, output: 'You and maya are already friends.\nYou have 1 friend.\nSee the board: atris 99 board --friends',
  });
  assert.deepEqual(await f.run('join', link, '--json'), { code: 0, output: JSON.stringify(data) });
});

test('join prints the server message when the invite cannot be used', async () => {
  for (const [answer, message] of [
    [failure(400, 'own_invite', 'That is your own invite link'), 'That is your own invite link'],
    [failure(404, 'invite_not_found', 'That invite link is not valid'), 'That invite link is not valid'],
    [failure(403, 'blocked', 'You cannot be friends with this person'), 'You cannot be friends with this person'],
    [failure(409, 'friends_full', 'You have 200 friends already'), 'You have 200 friends already'],
    [{ ok: false, status: 400, data: { detail: 'plain text detail' } }, 'plain text detail'],
    [{ ok: false, status: 500, data: null }, 'The 99 server could not do that (http 500). Try again.'],
  ]) {
    const f = fixture({ 'POST /99/invite/abcdefghjk/accept': answer });
    assert.deepEqual(await f.run('join', 'abcdefghjk'), { code: 1, output: message });
  }
});

test('join with something that is not a code or link asks for a new one without calling the server', async () => {
  for (const given of ['', 'not a code', 'https://example.com/other/path', 'project99://settings']) {
    const f = fixture({});
    const result = await f.run('join', given);
    assert.equal(result.code, 1, given);
    assert.equal(result.output, 'That is not an invite link or code. Ask your friend to send it again.');
    assert.equal(f.calls.length, 0);
  }
});

test('friends lists each friend with their points and streak today and sends the local time offset', async () => {
  const f = fixture({
    'GET /99/friends': ok({
      friends: [
        { id: 'u2', username: 'maya', display_name: 'Maya Chen', avatar_url: null, score: 82, streak: 4, since: '2026-11-20' },
        { id: 'u3', username: 'sam', display_name: 'sam', avatar_url: null, score: 0, streak: 0, since: '2026-11-24' },
      ],
      total: 2,
    }),
  });
  const result = await f.run('friends');
  assert.deepEqual(result, {
    code: 0,
    output: 'Your friends (2), points today\n  Maya Chen (@maya)  82 points  streak 4\n  sam                 0 points  streak 0',
  });
  assert.equal(f.calls[0].query.tz_offset_minutes, String(-new Date(2026, 10, 24, 12).getTimezoneOffset()));
  assert.equal(f.calls[0].token, 'tok-123');
});

test('friends with nobody yet points to the invite, and --json passes the answer through', async () => {
  const empty = { friends: [], total: 0 };
  const f = fixture({ 'GET /99/friends': ok(empty) });
  assert.deepEqual(await f.run('friends'), { code: 0, output: 'No friends yet. Get your link: atris 99 invite' });
  assert.deepEqual(await f.run('friends', '--json'), { code: 0, output: JSON.stringify(empty) });
});

test('unfriend finds the friend by username, with or without the @, and removes both ways', async () => {
  const list = ok({ friends: [
    { id: 'u2', username: 'maya', display_name: 'Maya Chen', score: 1, streak: 1 },
    { id: 'u3', username: 'sam', display_name: 'Sam', score: 2, streak: 2 },
  ], total: 2 });
  for (const given of ['maya', '@maya', 'MAYA']) {
    const f = fixture({ 'GET /99/friends': list, 'DELETE /99/friends/u2': ok({ removed: true, friends: 1 }) });
    assert.deepEqual(await f.run('unfriend', given), { code: 0, output: 'Removed Maya Chen.\nYou have 1 friend.' }, given);
    assert.deepEqual(f.calls.map((call) => `${call.method} ${call.path}`), ['GET /99/friends', 'DELETE /99/friends/u2']);
  }
  const gone = fixture({ 'GET /99/friends': list, 'DELETE /99/friends/u3': ok({ removed: false, friends: 1 }) });
  assert.deepEqual(await gone.run('unfriend', 'sam'), { code: 0, output: 'You were not friends with Sam.\nYou have 1 friend.' });
});

test('unfriend with a name nobody has, or one that matches twice, deletes nothing', async () => {
  const list = ok({ friends: [
    { id: 'u2', username: null, display_name: 'Alex', score: 1, streak: 1 },
    { id: 'u3', username: null, display_name: 'alex', score: 2, streak: 2 },
    { id: 'u4', username: 'kim', display_name: 'Kim', score: 2, streak: 2 },
  ], total: 3 });
  const f = fixture({ 'GET /99/friends': list });
  assert.deepEqual(await f.run('unfriend', 'nobody'), { code: 1, output: 'No friend named "nobody". See your friends: atris 99 friends' });
  assert.deepEqual(await f.run('unfriend', 'alex'), { code: 1, output: 'More than one friend matches "alex". Use their username.' });
  assert.ok(f.calls.every((call) => call.method === 'GET'));
});

test('the everyone board shows today by default with rank, name, points and streak, and marks you', async () => {
  const f = fixture({
    'GET /99/board': ok({
      window: 'day', day: '2026-11-24', total: 120,
      top: [entry(1, 'Maya', 99, 12), entry(2, 'Sam', 82, 4), entry(3, 'Kim', 7, 1)],
      you: entry(57, 'Keshav', 40, 3),
      around: [entry(2, 'Sam', 82, 4), entry(56, 'Lee', 41, 2), entry(57, 'Keshav', 40, 3), entry(58, 'Ola', 40, 0)],
    }),
  });
  const result = await f.run('board');
  assert.deepEqual(result, {
    code: 0,
    output: [
      'Everyone, today (120 people)',
      '   1  Maya          99 points  streak 12',
      '   2  Sam           82 points  streak 4',
      '   3  Kim            7 points  streak 1',
      '  ...',
      '  56  Lee           41 points  streak 2',
      '  57  Keshav (you)  40 points  streak 3',
      '  58  Ola           40 points  streak 0',
    ].join('\n'),
  });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].path, '/99/board');
  assert.equal(f.calls[0].query.window, 'day');
  assert.equal(f.calls[0].query.scope, undefined);
  assert.equal(f.calls[0].query.tz_offset_minutes, String(-new Date(2026, 10, 24, 12).getTimezoneOffset()));
});

test('the board takes day, week or all and --friends in any order, and sends the scope only for friends', async () => {
  const board = ok({ window: 'week', day: '2026-11-24', total: 2, top: [entry(1, 'Keshav', 300, 5), entry(2, 'Maya', 250, 4)], you: entry(1, 'Keshav', 300, 5), around: [entry(1, 'Keshav', 300, 5), entry(2, 'Maya', 250, 4)] });
  for (const [args, window, scope, label] of [
    [['week'], 'week', undefined, 'Everyone, this week (2 people)'],
    [['all'], 'all', undefined, 'Everyone, all time (2 people)'],
    [['day', '--friends'], 'day', 'friends', 'Friends, today (2 people)'],
    [['--friends', 'week'], 'week', 'friends', 'Friends, this week (2 people)'],
    [['--friends'], 'day', 'friends', 'Friends, today (2 people)'],
  ]) {
    const f = fixture({ 'GET /99/board': board });
    const result = await f.run('board', ...args);
    assert.equal(result.code, 0, args.join(' '));
    assert.equal(result.output.split('\n')[0], label);
    assert.equal(f.calls[0].query.window, window);
    assert.equal(f.calls[0].query.scope, scope);
  }
});

test('a friends board with only you shows you and points to the invite', async () => {
  const f = fixture({ 'GET /99/board': ok({
    window: 'day', day: '2026-11-24', total: 1, scope: 'friends',
    top: [entry(1, 'Keshav', 0, 0)], you: entry(1, 'Keshav', 0, 0), around: [entry(1, 'Keshav', 0, 0)],
  }) });
  assert.deepEqual(await f.run('board', '--friends'), {
    code: 0,
    output: 'Friends, today (1 person)\n  1  Keshav (you)  0 points  streak 0\nNo friends yet. Get your link: atris 99 invite',
  });
});

test('board --json prints the server answer untouched', async () => {
  const data = { window: 'all', day: '2026-11-24', total: 0, top: [], you: null, around: [], scope: 'friends' };
  const f = fixture({ 'GET /99/board': ok(data) });
  assert.deepEqual(await f.run('board', 'all', '--friends', '--json'), { code: 0, output: JSON.stringify(data) });
  const empty = fixture({ 'GET /99/board': ok({ window: 'day', total: 0, top: [], you: null, around: [] }) });
  assert.deepEqual(await empty.run('board'), { code: 0, output: 'Everyone, today (0 people)\nNobody on the board yet.' });
});

test('without a login every new command says to sign in and asks the server nothing', async () => {
  for (const args of [['invite'], ['join', 'abcdefghjk'], ['friends'], ['unfriend', 'maya'], ['board'], ['board', '--friends']]) {
    const f = fixture({}, { token: null });
    assert.deepEqual(await f.run(...args), { code: 1, output: 'Sign in first: atris login' }, args.join(' '));
    assert.equal(f.calls.length, 0);
  }
  const broken = [];
  const code = await ninetyNineAtris(['friends'], {
    log: (line) => broken.push(line), credentials: () => { throw new Error('bad login file'); }, request: async () => { throw new Error('no call'); },
  });
  assert.equal(code, 1);
  assert.deepEqual(broken, ['Sign in first: atris login']);
});

test('a refused login from the server says to sign in, and a dead connection says so plainly', async () => {
  const stale = fixture({ 'GET /99/friends': failure(401, 'unauthorized', 'Bearer tok-123 is no good') });
  assert.deepEqual(await stale.run('friends'), { code: 1, output: 'Sign in first: atris login' });
  const offline = fixture({ 'GET /99/board': new Error('socket hang up with Bearer tok-123') });
  assert.deepEqual(await offline.run('board'), { code: 1, output: 'Could not reach the 99 server. Try again.' });
  const down = fixture({ 'GET /99/invite': { ok: false, status: 0, data: null, error: 'ECONNREFUSED' } });
  assert.deepEqual(await down.run('invite'), { code: 1, output: 'Could not reach the 99 server. Try again.' });
  const odd = fixture({ 'GET /99/invite': ok(null) });
  assert.deepEqual(await odd.run('invite'), { code: 1, output: 'The 99 server sent something unexpected. Try again.' });
});

test('server messages are one line and never run on', async () => {
  const f = fixture({ 'GET /99/board': failure(400, 'invalid_scope', `Not a board\n${'x'.repeat(500)}`) });
  const result = await f.run('board', '--friends');
  assert.equal(result.code, 1);
  assert.ok(!result.output.includes('\n'));
  assert.ok(result.output.length <= 200);
});

test('wrong arguments are usage errors that never touch the login or the server', async () => {
  for (const [args, usage] of [
    [['invite', 'extra'], 'usage: atris 99 invite [--json]'],
    [['join'], 'usage: atris 99 join <code or link>'],
    [['join', 'a', 'b'], 'usage: atris 99 join <code or link>'],
    [['friends', 'now'], 'usage: atris 99 friends [--json]'],
    [['unfriend'], 'usage: atris 99 unfriend <username>'],
    [['unfriend', 'a', 'b'], 'usage: atris 99 unfriend <username>'],
    [['board', 'month'], 'usage: atris 99 board [day|week|all] [--friends] [--json]'],
    [['board', 'day', 'week'], 'usage: atris 99 board [day|week|all] [--friends] [--json]'],
    [['board', '--everyone'], 'usage: atris 99 board [day|week|all] [--friends] [--json]'],
    [['invite', '--friends'], 'usage: atris 99 invite [--json]'],
  ]) {
    const f = fixture({}, { token: null });
    assert.deepEqual(await f.run(...args), { code: 2, output: usage }, args.join(' '));
    assert.equal(f.calls.length, 0);
  }
});

test('help lists the new commands and a length number still starts a focus block', async (t) => {
  const f = fixture({});
  for (const args of [['help'], ['--help'], ['board', '--help']]) {
    const result = await f.run(...args);
    assert.equal(result.code, 0);
    for (const entry of [
      'atris 99 invite', 'atris 99 join <code or link>', 'atris 99 friends', 'atris 99 unfriend <username>',
      'atris 99 board [day|week|all] [--friends] [--json]',
    ]) assert.ok(result.output.includes(entry), entry);
  }
  assert.equal(f.calls.length, 0);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-99-friends-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const lines = [];
  const code = await ninetyNineAtris(['50'], {
    logPath: path.join(dir, 'sessions.jsonl'), now: () => new Date(2026, 10, 24, 12), log: (line) => lines.push(line),
    interactive: false, suggestion: () => '', request: async () => { throw new Error('no call'); },
  });
  assert.equal(code, 0);
  assert.match(lines[0], /^Focus 50 started\./);
});

test('the real command says to sign in when this computer has no login', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-99-friends-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = { ...process.env, HOME: dir, USERPROFILE: dir, ATRIS_99_LOG: path.join(dir, 'sessions.jsonl') };
  for (const key of Object.keys(env)) if (/^ATRIS_(TOKEN|API_KEY|KEY)/.test(key)) delete env[key];
  const result = spawnSync(process.execPath, [cli, '99', 'friends'], { cwd: dir, env, encoding: 'utf8', timeout: 15000 });
  assert.ifError(result.error);
  assert.equal(result.stdout, 'Sign in first: atris login\n');
  assert.equal(result.status, 1);
});

test('the command file calls the three friends routes of the 99 server', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../commands/ninety-nine.js'), 'utf8');
  for (const route of ['99/friends', '99/invite', '99/board']) assert.ok(source.includes(route), route);
});
