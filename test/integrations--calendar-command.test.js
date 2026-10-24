const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Everything below runs offline: HOME points at a temp dir, ATRIS_* is cleared,
// and the one network function (utils/api apiRequestJson) is replaced before
// commands/integrations loads and binds it.
const savedEnv = { ...process.env };
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-calendar-command-'));
for (const key of Object.keys(process.env)) {
  if (key.startsWith('ATRIS_')) delete process.env[key];
}
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;
// A fixed terminal id keeps the auth code from shelling out to `tty`.
process.env.TERM_SESSION_ID = 'calendar-command-test';

const api = require('../utils/api');
const apiCalls = [];
let apiReply = { ok: false, status: 500, error: 'no reply queued' };
api.apiRequestJson = async (url, opts) => {
  apiCalls.push({ url, opts });
  return typeof apiReply === 'function' ? apiReply(url, opts) : apiReply;
};

const { calendarCommand } = require('../commands/integrations');

const CACHE_PATH = path.join(tmpHome, '.atris', 'calendar-events-cache.json');

// Unsigned JWT with type agent_access and a year-2100 expiry: the auth layer
// accepts it without any validation request and without reading the clock.
function fakeAgentToken() {
  const part = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${part({ alg: 'none', typ: 'JWT' })}.${part({ type: 'agent_access', exp: 4102444800 })}.sig`;
}
const TOKEN = fakeAgentToken();

class ExitSignal extends Error {
  constructor(code) {
    super(`process.exit(${code})`);
    this.code = code;
  }
}

async function run(...args) {
  const out = [];
  const err = [];
  const originalLog = console.log;
  const originalError = console.error;
  const originalExit = process.exit;
  let exitCode = null;
  console.log = (...parts) => out.push(parts.join(' '));
  console.error = (...parts) => err.push(parts.join(' '));
  process.exit = (code) => { throw new ExitSignal(code); };
  try {
    await calendarCommand(...args);
  } catch (error) {
    if (!(error instanceof ExitSignal)) throw error;
    exitCode = error.code;
  } finally {
    console.log = originalLog;
    console.error = originalError;
    process.exit = originalExit;
  }
  return { out, err, stdout: out.join('\n'), stderr: err.join('\n'), exitCode };
}

function reset({ loggedIn = false, reply } = {}) {
  apiCalls.length = 0;
  apiReply = reply || { ok: false, status: 500, error: 'no reply queued' };
  fs.rmSync(CACHE_PATH, { force: true });
  if (loggedIn) process.env.ATRIS_TOKEN = TOKEN;
  else delete process.env.ATRIS_TOKEN;
}

const SEARCH_EVENTS = [
  { id: 'evt-1', summary: 'Investor call', location: 'Zoom', start: { date: '2026-05-20' }, end: { date: '2026-05-21' } },
  { id: 'evt-2', summary: 'Product review', location: 'Office', start: { date: '2026-05-21' }, end: { date: '2026-05-22' } },
  { id: 'evt-3', summary: 'Design review', location: 'Studio', start: { date: '2026-05-22' }, end: { date: '2026-05-23' } },
];

test.after(() => {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

test('calendarCommand prints the command list for no subcommand or an unknown one', async () => {
  for (const sub of [undefined, 'nope']) {
    reset();
    const result = await run(sub);
    assert.strictEqual(result.exitCode, null);
    assert.strictEqual(result.err.length, 0);
    assert.strictEqual(result.out.length, 7);
    assert.strictEqual(result.out[0], 'Calendar commands:');
    assert.match(result.out[1], /atris calendar today\b/);
    assert.match(result.out[2], /atris calendar yesterday\b/);
    assert.match(result.out[3], /atris calendar week\b/);
    assert.match(result.out[4], /atris calendar date YYYY-MM-DD/);
    assert.match(result.out[5], /atris calendar search <query>/);
    assert.match(result.out[6], /atris calendar add "Title" --date YYYY-MM-DD --from HH:MM --to HH:MM/);
    assert.strictEqual(apiCalls.length, 0);
  }
});

test('calendarCommand date rejects a missing, malformed, or impossible date before any request', async () => {
  for (const bad of [undefined, '', '2026-8-4', 'tomorrow']) {
    reset({ loggedIn: true });
    const result = await run('date', bad);
    assert.strictEqual(result.exitCode, 1, `exit code for ${String(bad)}`);
    assert.strictEqual(result.stderr, 'Usage: atris calendar date YYYY-MM-DD');
    assert.strictEqual(result.stdout, '');
    assert.strictEqual(apiCalls.length, 0);
  }

  reset({ loggedIn: true });
  const impossible = await run('date', '2026-13-45');
  assert.strictEqual(impossible.exitCode, 1);
  assert.strictEqual(impossible.stderr, 'Invalid date. Use YYYY-MM-DD.');
  assert.strictEqual(apiCalls.length, 0);
});

test('calendarCommand date asks for local midnight to local midnight and reports an empty day', async () => {
  reset({ loggedIn: true, reply: { ok: true, data: { events: [] } } });
  const result = await run('date', '2026-08-24');

  assert.strictEqual(result.exitCode, null);
  assert.strictEqual(apiCalls.length, 1);
  const { url, opts } = apiCalls[0];
  assert.ok(url.startsWith('/integrations/google-calendar/events?'), url);
  assert.strictEqual(opts.method, 'GET');
  assert.strictEqual(opts.token, TOKEN);
  const params = new URL(url, 'https://example.invalid').searchParams;
  assert.strictEqual(params.get('time_min'), new Date('2026-08-24T00:00:00').toISOString());
  assert.strictEqual(params.get('time_max'), new Date('2026-08-25T00:00:00').toISOString());
  assert.strictEqual(params.get('days'), null);
  assert.deepStrictEqual(result.out, ['📅 Events on 2026-08-24:\n', 'No events on 2026-08-24.']);
});

test('calendarCommand today lists events and writes the offline cache', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-05-20T12:00:00') });
  reset({
    loggedIn: true,
    reply: {
      ok: true,
      data: {
        events: [
          { id: 'a', summary: 'Standup', location: 'HQ', start: { date: '2026-05-20' } },
          { id: 'b', start: '2026-05-20' },
        ],
      },
    },
  });
  const result = await run('today');

  assert.strictEqual(result.exitCode, null);
  assert.strictEqual(apiCalls.length, 1);
  const params = new URL(apiCalls[0].url, 'https://example.invalid').searchParams;
  assert.strictEqual(params.get('time_min'), new Date('2026-05-20T00:00:00').toISOString());
  assert.strictEqual(params.get('time_max'), new Date('2026-05-21T00:00:00').toISOString());
  assert.strictEqual(params.get('days'), null);
  assert.strictEqual(result.out[0], "📅 Today's events:\n");
  const bar = '─'.repeat(50);
  assert.deepStrictEqual(result.out.slice(1), [
    bar,
    'All day  Standup',
    '        📍 HQ',
    'All day  (no title)',
    bar,
  ]);

  const cache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
  assert.strictEqual(cache.ok, true);
  assert.strictEqual(cache.source, 'calendarRange');
  assert.strictEqual(cache.days, null);
  assert.strictEqual(cache.count, 2);
  assert.deepStrictEqual(cache.events[0], {
    id: 'a', start: '2026-05-20', end: '', summary: 'Standup', location: 'HQ', htmlLink: '',
  });
});

test('calendarCommand today and week handle an empty calendar and accept a bare array reply', async () => {
  reset({ loggedIn: true, reply: { ok: true, data: { events: [] } } });
  const today = await run('today');
  assert.strictEqual(today.exitCode, null);
  assert.deepStrictEqual(today.out, ["📅 Today's events:\n", "No today's events."]);

  reset({ loggedIn: true, reply: { ok: true, data: [{ summary: 'Retro', start: { date: '2026-05-22' } }] } });
  const week = await run('week');
  assert.strictEqual(week.exitCode, null);
  assert.strictEqual(apiCalls[0].url, '/integrations/google-calendar/events?days=7');
  assert.strictEqual(week.out[0], "📅 This week's events:\n");
  assert.ok(week.out.includes('All day  Retro'));
});

test('calendarCommand range commands exit 1 with a clear message when the request fails', async () => {
  reset({ loggedIn: true, reply: { ok: false, status: 401, error: 'unauthorized' } });
  const notConnected = await run('week');
  assert.strictEqual(notConnected.exitCode, 1);
  assert.deepStrictEqual(notConnected.err, [
    'Calendar not connected for unknown.',
    'Connect at: https://atris.ai/dashboard/settings',
    "Make sure you're signed in as unknown on the web.",
  ]);

  reset({ loggedIn: true, reply: { ok: false, status: 503, error: 'server down' } });
  const serverError = await run('today');
  assert.strictEqual(serverError.exitCode, 1);
  assert.deepStrictEqual(serverError.err, ['Error: server down']);

  reset({ loggedIn: true, reply: { ok: false, status: 500 } });
  const noDetail = await run('today');
  assert.strictEqual(noDetail.exitCode, 1);
  assert.deepStrictEqual(noDetail.err, ['Error: Failed to fetch events']);
});

test('calendarCommand range commands exit 1 when not logged in, without calling the API', async () => {
  reset();
  const result = await run('today');
  assert.strictEqual(result.exitCode, 1);
  assert.strictEqual(result.stderr, 'Not logged in. Run: atris login');
  assert.strictEqual(apiCalls.length, 0);
});

test('calendarCommand search without a query prints usage and exits 1', async () => {
  for (const args of [[], ['   '], ['--days', '5', '--json']]) {
    reset({ loggedIn: true });
    const result = await run('search', ...args);
    assert.strictEqual(result.exitCode, 1, JSON.stringify(args));
    assert.strictEqual(
      result.stderr,
      'Usage: atris calendar search <query> [--days 30] [--limit 20] [--timeout-ms 10000] [--json]',
    );
    assert.strictEqual(apiCalls.length, 0);
  }
});

test('calendarCommand search reports not logged in as JSON or as an error', async () => {
  reset();
  const json = await run('search', 'investor', '--json');
  assert.strictEqual(json.exitCode, null);
  assert.deepStrictEqual(JSON.parse(json.stdout), {
    ok: false,
    query: 'investor',
    status: 401,
    error: 'Not logged in. Run: atris login',
    totalEvents: 0,
    matchCount: 0,
    matches: [],
  });

  const plain = await run('search', 'investor');
  assert.strictEqual(plain.exitCode, 1);
  assert.strictEqual(plain.stderr, 'Error: Not logged in. Run: atris login');
  assert.strictEqual(apiCalls.length, 0);
});

test('calendarCommand search returns matching events as JSON with bounded request options', async () => {
  reset({ loggedIn: true, reply: { ok: true, data: { events: SEARCH_EVENTS } } });
  const result = await run('search', 'review', '--json', '--days', '10', '--limit', '1', '--timeout-ms', '2500');

  assert.strictEqual(result.exitCode, null);
  assert.strictEqual(apiCalls.length, 1);
  assert.strictEqual(apiCalls[0].url, '/integrations/google-calendar/events?days=10');
  assert.deepStrictEqual(apiCalls[0].opts, { method: 'GET', token: TOKEN, timeoutMs: 2500, retries: 0 });

  const parsed = JSON.parse(result.stdout);
  assert.strictEqual(parsed.ok, true);
  assert.strictEqual(parsed.query, 'review');
  assert.strictEqual(parsed.source, 'live');
  assert.strictEqual(parsed.liveOk, true);
  assert.strictEqual(parsed.totalEvents, 3);
  assert.strictEqual(parsed.matchCount, 1);
  assert.deepStrictEqual(parsed.matches, [
    { id: 'evt-2', start: '2026-05-21', end: '2026-05-22', summary: 'Product review', location: 'Office', htmlLink: '' },
  ]);
});

test('calendarCommand search prints a readable list, joins query words, and handles no match', async () => {
  reset({ loggedIn: true, reply: { ok: true, data: { events: SEARCH_EVENTS } } });
  const found = await run('search', 'investor', 'call');
  assert.strictEqual(found.exitCode, null);
  assert.strictEqual(apiCalls[0].url, '/integrations/google-calendar/events?days=30');
  assert.strictEqual(found.out[0], 'Found 1 upcoming event(s) matching "investor call":\n');
  assert.ok(found.out.includes('All day  Investor call'));
  assert.ok(found.out.includes('        📍 Zoom'));
  assert.ok(!found.stdout.includes('Product review'));

  const none = await run('search', 'zebra');
  assert.strictEqual(none.exitCode, null);
  assert.deepStrictEqual(none.out, ['No upcoming events matched "zebra".']);

  reset({ loggedIn: true, reply: { ok: true, data: { events: [] } } });
  const empty = await run('search', 'anything', '--json');
  const parsed = JSON.parse(empty.stdout);
  assert.strictEqual(parsed.ok, true);
  assert.strictEqual(parsed.totalEvents, 0);
  assert.deepStrictEqual(parsed.matches, []);
});

test('calendarCommand search falls back to the cache only for --json, otherwise reports the failure', async () => {
  reset({ loggedIn: true, reply: { ok: true, data: { events: SEARCH_EVENTS } } });
  await run('search', 'review');
  assert.ok(fs.existsSync(CACHE_PATH));

  apiReply = { ok: false, status: 0, error: 'Request timeout after 10s' };
  const cached = await run('search', 'review', '--json');
  assert.strictEqual(cached.exitCode, null);
  const parsed = JSON.parse(cached.stdout);
  assert.strictEqual(parsed.ok, true);
  assert.strictEqual(parsed.source, 'cache');
  assert.strictEqual(parsed.liveOk, false);
  assert.strictEqual(parsed.error, 'Request timeout after 10s');
  assert.strictEqual(parsed.totalEvents, 3);
  assert.deepStrictEqual(parsed.matches.map((m) => m.id), ['evt-2', 'evt-3']);
  assert.ok(parsed.cacheUpdatedAt);

  const plain = await run('search', 'review');
  assert.strictEqual(plain.exitCode, 1);
  assert.strictEqual(plain.stderr, 'Error: Request timeout after 10s');
});

test('calendarCommand search failure with no cache is a machine-readable error in JSON mode', async () => {
  reset({ loggedIn: true, reply: { ok: false, status: 502, error: 'bad gateway' } });
  const json = await run('search', 'review', '--json');
  assert.strictEqual(json.exitCode, null);
  assert.deepStrictEqual(JSON.parse(json.stdout), {
    ok: false,
    query: 'review',
    status: 502,
    error: 'bad gateway',
    totalEvents: 0,
    matchCount: 0,
    matches: [],
  });

  reset({ loggedIn: true, reply: { ok: false, status: 401, error: 'unauthorized' } });
  const plain = await run('search', 'review');
  assert.strictEqual(plain.exitCode, 1);
  assert.strictEqual(
    plain.stderr,
    'Error: Calendar not connected for unknown. Connect at: https://atris.ai/dashboard/settings',
  );

  reset({ loggedIn: true, reply: { ok: false, status: 400 } });
  const badRequest = await run('search', 'review', '--json');
  assert.strictEqual(JSON.parse(badRequest.stdout).status, 400);
  assert.match(JSON.parse(badRequest.stdout).error, /^Calendar not connected for unknown/);
});

test('calendarCommand add rejects missing title or times before any request', async () => {
  const usage = 'Usage: atris calendar add "Title" --date YYYY-MM-DD --from HH:MM --to HH:MM';
  const cases = [
    [],
    ['Lunch'],
    ['Lunch', '--date', '2026-05-20', '--from', '12:00'],
    ['--date', '2026-05-20', '--from', '12:00', '--to', '13:00'],
    ['Lunch', '--start', '2026-05-20T12:00:00'],
  ];
  for (const args of cases) {
    reset({ loggedIn: true });
    const result = await run('add', ...args);
    assert.strictEqual(result.exitCode, 1, JSON.stringify(args));
    assert.strictEqual(result.err[0], usage);
    assert.strictEqual(result.err[1], '   or: atris calendar add "Title" --start <ISO datetime> --end <ISO datetime>');
    assert.strictEqual(result.stdout, '');
    assert.strictEqual(apiCalls.length, 0);
  }
});

test('calendarCommand add builds the event from date and times and prints the confirmation', async () => {
  reset({
    loggedIn: true,
    reply: { ok: true, data: { summary: 'Team lunch', htmlLink: 'https://calendar.example/e/1', verified: true } },
  });
  const result = await run(
    'add', 'Team', 'lunch', '--date', '2026-05-20', '--from', '12:00', '--to', '13:30',
    '--location', 'Cafe', '--description', 'Monthly', '--timezone', 'America/Los_Angeles',
  );

  assert.strictEqual(result.exitCode, null);
  assert.strictEqual(apiCalls.length, 1);
  assert.strictEqual(apiCalls[0].url, '/integrations/google-calendar/events');
  assert.strictEqual(apiCalls[0].opts.method, 'POST');
  assert.strictEqual(apiCalls[0].opts.token, TOKEN);
  assert.deepStrictEqual(apiCalls[0].opts.body, {
    summary: 'Team lunch',
    start: '2026-05-20T12:00:00',
    end: '2026-05-20T13:30:00',
    location: 'Cafe',
    description: 'Monthly',
    timezone: 'America/Los_Angeles',
  });
  assert.deepStrictEqual(result.out, [
    'Creating event: Team lunch (2026-05-20T12:00:00 to 2026-05-20T13:30:00)...',
    'Created: Team lunch',
    'Link: https://calendar.example/e/1',
    'Verified on calendar: yes',
  ]);
});

test('calendarCommand create alias takes explicit start and end and reports an unverified event', async () => {
  reset({ loggedIn: true, reply: { ok: true, data: {} } });
  const result = await run('create', 'Dentist', '--start', '2026-06-01T09:00:00-07:00', '--end', '2026-06-01T10:00:00-07:00');

  assert.strictEqual(result.exitCode, null);
  assert.deepStrictEqual(apiCalls[0].opts.body, {
    summary: 'Dentist',
    start: '2026-06-01T09:00:00-07:00',
    end: '2026-06-01T10:00:00-07:00',
  });
  assert.deepStrictEqual(result.out, [
    'Creating event: Dentist (2026-06-01T09:00:00-07:00 to 2026-06-01T10:00:00-07:00)...',
    'Created: Dentist',
    'Verified on calendar: no',
  ]);
});

test('calendarCommand add exits 1 with the server error, or when not logged in', async () => {
  reset({ loggedIn: true, reply: { ok: false, status: 429, error: 'quota exceeded' } });
  const failed = await run('add', 'Dentist', '--start', '2026-06-01T09:00:00', '--end', '2026-06-01T10:00:00');
  assert.strictEqual(failed.exitCode, 1);
  assert.strictEqual(failed.stderr, 'Error: quota exceeded');
  assert.strictEqual(apiCalls.length, 1);

  reset({ loggedIn: true, reply: { ok: false, status: 500 } });
  const noDetail = await run('add', 'Dentist', '--start', '2026-06-01T09:00:00', '--end', '2026-06-01T10:00:00');
  assert.strictEqual(noDetail.stderr, 'Error: Failed to create event');

  reset();
  const loggedOut = await run('add', 'Dentist', '--start', '2026-06-01T09:00:00', '--end', '2026-06-01T10:00:00');
  assert.strictEqual(loggedOut.exitCode, 1);
  assert.strictEqual(loggedOut.stderr, 'Not logged in. Run: atris login');
  assert.strictEqual(apiCalls.length, 0);
});
