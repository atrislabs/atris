'use strict';

// atris listen: a team member's inbox on the team board.
// Every test here talks to a fake server; nothing touches the network.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { listenCommand } = require('../commands/listen');
const { knownCommands } = require('../lib/known-commands');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-listen-'));
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

const TOKEN = 'secret-tok-1a2b3c4d5e6f';
const LABS_ID = '5db129d0-aa32-46eb-81ae-29bb86f67b0f';
const NOW = Date.parse('2026-11-11T20:00:00Z');
const MEMBERS = { walsh: 'agent-walsh-id' };
const REGISTRY = { 'atris-labs': { business_id: LABS_ID, name: 'Atris Labs', slug: 'atris-labs' } };

// Sent newest first on purpose: the command must still show oldest first.
const ITEMS = [
  { seq: 42, reason: 'task', post_id: 'p42', channel: 'experiments', content: 'run the smoke test', author_id: 'a-muse', author_name: 'Muse', created_at: '2026-11-11T19:58:00Z' },
  { seq: 40, reason: 'mention', post_id: 'p40', channel: 'general', content: '@walsh can you check this', author_id: 'a-thorp', author_name: 'thorp', created_at: '2026-11-11T19:30:00Z' },
];

function makeDir(prefix) { return fs.mkdtempSync(path.join(scratch, prefix)); }
function makeHome(registry) {
  const home = makeDir('home-');
  fs.mkdirSync(path.join(home, '.atris'), { recursive: true });
  if (registry) fs.writeFileSync(path.join(home, '.atris', 'businesses.json'), JSON.stringify(registry));
  return home;
}

function fakeServer({ items = ITEMS, readUpTo = 39, overrides = {} } = {}) {
  return async (pathname, options = {}) => {
    const method = options.method || 'GET';
    const key = `${method} ${pathname.split('?')[0]}`;
    if (overrides[key]) return overrides[key](options, pathname);
    const team = pathname.match(/^\/business\/[^/]+\/team\/([^/]+)$/);
    if (method === 'GET' && team) {
      return MEMBERS[team[1]]
        ? { ok: true, status: 200, data: { agent_id: MEMBERS[team[1]], name: team[1] } }
        : { ok: false, status: 404, data: { detail: 'Team member not found' } };
    }
    if (key === `GET /swarlo/${LABS_ID}/inbox`) return { ok: true, status: 200, data: { items, read_up_to: readUpTo } };
    if (key === `POST /swarlo/${LABS_ID}/inbox/ack`) return { ok: true, status: 200, data: { read_up_to: options.body.seq } };
    return { ok: false, status: 404, data: { detail: 'Not Found' } };
  };
}

function harness({ handler = fakeServer(), env = {} } = {}) {
  const stdout = [];
  const stderr = [];
  const calls = [];
  return {
    stdout,
    stderr,
    calls,
    deps: {
      token: TOKEN,
      env: { ATRIS_BUSINESS: 'atris-labs', ...env },
      cwd: makeDir('cwd-'),
      homeDir: makeHome(REGISTRY),
      now: () => NOW,
      apiRequestJson: async (pathname, options = {}) => {
        calls.push({ pathname, method: options.method || 'GET', body: options.body, token: options.token });
        return handler(pathname, options);
      },
      log: (l) => stdout.push(String(l)),
      err: (l) => stderr.push(String(l)),
    },
  };
}

test('listen is a known command and shows in help --all', async () => {
  assert.ok(knownCommands.includes('listen'));
  const res = await runCli(['help', '--all'], { cwd: makeDir('cwd-'), env: { HOME: makeHome() } });
  assert.match(res.stdout, /\n\s+listen\s+-/);
});

test('new items print oldest first, one line each, then how to mark them handled; exit 0', async () => {
  const h = harness();
  assert.equal(await listenCommand(['--as', 'walsh'], h.deps), 0);
  assert.equal(h.stdout.length, 3, h.stdout.join('\n'));
  assert.match(h.stdout[0], /^#general\s+thorp\s+30 min ago\s+\[mention\] @walsh can you check this$/);
  assert.match(h.stdout[1], /^#experiments\s+Muse\s+2 min ago\s+\[task\] run the smoke test$/);
  assert.equal(h.stdout[2], 'mark handled: atris listen --as walsh --ack 42');
  const read = h.calls.find((c) => c.pathname.includes('/inbox'));
  assert.equal(read.pathname, `/swarlo/${LABS_ID}/inbox?agent_id=agent-walsh-id&limit=20`);
  assert.equal(read.method, 'GET');
  assert.equal(read.token, TOKEN);
});

test('an empty inbox prints one calm line and exits 1', async () => {
  const h = harness({ handler: fakeServer({ items: [], readUpTo: 42 }) });
  assert.equal(await listenCommand(['--as', 'walsh'], h.deps), 1);
  assert.deepEqual(h.stdout, ['nothing new for walsh.']);
  assert.deepEqual(h.stderr, []);
});

test('--json prints the server reply as is, with the same exit codes', async () => {
  const h = harness();
  assert.equal(await listenCommand(['--as', 'walsh', '--json'], h.deps), 0);
  assert.equal(h.stdout.length, 1);
  assert.deepEqual(JSON.parse(h.stdout[0]), { items: ITEMS, read_up_to: 39 });
  const empty = harness({ handler: fakeServer({ items: [], readUpTo: 42 }) });
  assert.equal(await listenCommand(['--as', 'walsh', '--json'], empty.deps), 1);
  assert.deepEqual(JSON.parse(empty.stdout[0]), { items: [], read_up_to: 42 });
});

test('--ack posts the member agent id and the number, prints one line, exits 0', async () => {
  const h = harness();
  assert.equal(await listenCommand(['--as', 'walsh', '--ack', '42'], h.deps), 0);
  const sent = h.calls.filter((c) => c.method === 'POST');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].pathname, `/swarlo/${LABS_ID}/inbox/ack`);
  assert.deepEqual(sent[0].body, { agent_id: 'agent-walsh-id', seq: 42 });
  assert.deepEqual(h.stdout, ['marked handled for walsh, up to 42.']);
});

test('--ack below what is already handled says nothing changed', async () => {
  const handler = fakeServer({ overrides: { [`POST /swarlo/${LABS_ID}/inbox/ack`]: () => ({ ok: true, status: 200, data: { read_up_to: 50 } }) } });
  const h = harness({ handler });
  assert.equal(await listenCommand(['--as', 'walsh', '--ack', '42'], h.deps), 0);
  assert.match(h.stdout[0], /already handled up to 50/);
});

test('--ack with something that is not a whole number sends nothing and exits 2', async () => {
  const h = harness();
  assert.equal(await listenCommand(['--as', 'walsh', '--ack', 'abc'], h.deps), 2);
  assert.equal(h.calls.length, 0);
});

test('an unknown member exits 2 and nothing is read or marked', async () => {
  for (const extra of [[], ['--ack', '5']]) {
    const h = harness();
    assert.equal(await listenCommand(['--as', 'nobody', ...extra], h.deps), 2);
    assert.match(h.stderr.join('\n'), /no member called "nobody"/);
    assert.ok(h.calls.every((c) => !c.pathname.includes('/inbox')), 'touched the inbox');
  }
});

test('no member named at all exits 2 with the one-line fix and sends nothing', async () => {
  const h = harness();
  assert.equal(await listenCommand([], h.deps), 2);
  assert.deepEqual(h.stderr, ['say who is listening: atris listen --as <member>']);
  assert.equal(h.calls.length, 0);
});

test('ATRIS_AGENT is the member when --as is left off; --as wins over it', async () => {
  const h = harness({ env: { ATRIS_AGENT: 'walsh' } });
  assert.equal(await listenCommand([], h.deps), 0);
  const other = harness({ env: { ATRIS_AGENT: 'walsh' } });
  assert.equal(await listenCommand(['--as', '@Nobody'], other.deps), 2);
  assert.match(other.stderr.join('\n'), /"nobody"/);
});

test('a refused sign-in (401) says to sign in again and exits 2', async () => {
  const refused = () => ({ ok: false, status: 401, data: { detail: 'Invalid token' } });
  const handler = fakeServer({ overrides: { [`GET /swarlo/${LABS_ID}/inbox`]: refused } });
  const h = harness({ handler });
  assert.equal(await listenCommand(['--as', 'walsh'], h.deps), 2);
  assert.match(h.stderr.join('\n'), /sign-in was refused\. run: atris login/);
});

test('not signed in at all says so and exits 2', async () => {
  const h = harness();
  h.deps.token = '';
  h.deps.ensureCredentials = async () => ({ error: 'not_logged_in' });
  assert.equal(await listenCommand(['--as', 'walsh'], h.deps), 2);
  assert.match(h.stderr.join('\n'), /not logged in/);
  assert.equal(h.calls.length, 0);
});

test('a server without inboxes yet says so plainly and exits 2', async () => {
  const h = harness({ handler: fakeServer({ overrides: { [`GET /swarlo/${LABS_ID}/inbox`]: () => ({ ok: false, status: 404, data: { detail: 'Not Found' } }) } }) });
  assert.equal(await listenCommand(['--as', 'walsh'], h.deps), 2);
  assert.match(h.stderr.join('\n'), /no inboxes yet/);
});

test('a full page says more are waiting', async () => {
  const h = harness();
  assert.equal(await listenCommand(['--as', 'walsh', '--limit', '2'], h.deps), 0);
  assert.match(h.stdout.join('\n'), /more are waiting/);
  assert.ok(h.calls.some((c) => c.pathname.endsWith('&limit=2')));
});

test('unknown flags, stray words, and a bad --limit stop before any request', async () => {
  for (const args of [['--as', 'walsh', '--yolo'], ['walsh'], ['--as', 'walsh', '--limit', '99'], ['--as', 'walsh', '--watch', '--ack', '3']]) {
    const h = harness();
    assert.equal(await listenCommand(args, h.deps), 2, args.join(' '));
    assert.equal(h.calls.length, 0, args.join(' '));
  }
});

test('--watch prints only items it has not shown, and never marks anything handled', async () => {
  const rounds = [
    [ITEMS[1]],
    [ITEMS[1], ITEMS[0]],
    [ITEMS[1], ITEMS[0]],
  ];
  let round = 0;
  const handler = fakeServer({ overrides: { [`GET /swarlo/${LABS_ID}/inbox`]: () => ({ ok: true, status: 200, data: { items: rounds[round], read_up_to: 39 } }) } });
  const h = harness({ handler });
  h.deps.sleep = async () => { round += 1; };
  h.deps.keepGoing = () => round < rounds.length - 1;
  assert.equal(await listenCommand(['--as', 'walsh', '--watch'], h.deps), 0);
  const out = h.stdout.join('\n');
  assert.equal((out.match(/@walsh can you check this/g) || []).length, 1, out);
  assert.equal((out.match(/run the smoke test/g) || []).length, 1, out);
  assert.match(out, /--ack 42/);
  assert.equal(h.calls.filter((c) => c.method === 'POST').length, 0);
  assert.equal(h.calls.filter((c) => c.pathname.includes('/inbox?')).length, 3);
});

test('the token never appears in any output, even when the server echoes it', async () => {
  const echo = () => ({ ok: false, status: 500, data: { detail: `bad token ${TOKEN}` } });
  const handler = fakeServer({ overrides: { [`GET /swarlo/${LABS_ID}/inbox`]: echo, [`POST /swarlo/${LABS_ID}/inbox/ack`]: echo } });
  for (const args of [['--as', 'walsh'], ['--as', 'walsh', '--ack', '1'], ['--as', 'walsh', '--json']]) {
    const h = harness({ handler });
    assert.equal(await listenCommand(args, h.deps), 2);
    const all = h.stdout.concat(h.stderr).join('\n');
    assert.ok(!all.includes(TOKEN), `token leaked on ${args.join(' ')}`);
    assert.ok(h.stderr.length > 0);
  }
});

// ── the real CLI against a local HTTP server ────────────────

function runCli(args, { cwd, env = {} }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd,
      env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1', ATRIS_TOKEN: '', ATRIS_AGENT: '', ATRIS_BUSINESS: '', ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

test('the installed command reads, acks, and exits 0/1/2 through a real HTTP server', async () => {
  const seen = [];
  let unread = ITEMS.slice();
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
      const send = (code, data) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
      if (req.url === '/api/auth/validate') return send(200, { valid: true, user: { id: 'u1' } });
      if (req.url === '/api/business/atris-labs/team/walsh') return send(200, { agent_id: 'agent-walsh-id', name: 'walsh' });
      if (req.url.startsWith('/api/business/atris-labs/team/')) return send(404, { detail: 'Team member not found' });
      if (req.method === 'GET' && req.url.startsWith('/api/swarlo/atris-labs/inbox?')) return send(200, { items: unread, read_up_to: 39 });
      if (req.method === 'POST' && req.url === '/api/swarlo/atris-labs/inbox/ack') {
        const seq = JSON.parse(body).seq;
        unread = unread.filter((it) => it.seq > seq);
        return send(200, { read_up_to: seq });
      }
      return send(404, { detail: 'Not Found' });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const env = { HOME: makeHome(), ATRIS_API_URL: `http://127.0.0.1:${port}/api`, ATRIS_TOKEN: TOKEN, ATRIS_BUSINESS: 'atris-labs' };
    const cwd = makeDir('cwd-');
    const read = await runCli(['listen', '--as', 'walsh', '--json'], { cwd, env });
    assert.equal(read.status, 0, read.stderr);
    assert.equal(JSON.parse(read.stdout).items.length, 2);
    const ack = await runCli(['listen', '--as', 'walsh', '--ack', '42'], { cwd, env });
    assert.equal(ack.status, 0, ack.stderr);
    assert.deepEqual(JSON.parse(seen.find((s) => s.method === 'POST' && s.url.endsWith('/inbox/ack')).body), { agent_id: 'agent-walsh-id', seq: 42 });
    const empty = await runCli(['listen', '--as', 'walsh'], { cwd, env });
    assert.equal(empty.status, 1, empty.stderr);
    assert.match(empty.stdout, /nothing new for walsh/);
    const nobody = await runCli(['listen', '--as', 'nobody'], { cwd, env });
    assert.equal(nobody.status, 2);
    const missing = await runCli(['listen'], { cwd, env });
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /say who is listening/);
    for (const s of seen) assert.equal(s.auth, `Bearer ${TOKEN}`);
    for (const r of [read, ack, empty, nobody, missing]) assert.ok(!(r.stdout + r.stderr).includes(TOKEN));
  } finally {
    server.close();
  }
});

// ── review fixes: numbers, sign-in, errors, speed, quiet stdout ─────────

test('--ack and --limit take plain whole numbers only: 0, 1e2, 0x2a, 4.0 are refused before any request', async () => {
  const bad = [['--ack', '0'], ['--ack', '1e2'], ['--ack', '0x2a'], ['--ack', '4.0'], ['--ack', '+5'], ['--ack', '07'], ['--limit', '1e1'], ['--limit', '0x10'], ['--limit', '51'], ['--limit', '0']];
  for (const extra of bad) {
    const h = harness();
    assert.equal(await listenCommand(['--as', 'walsh', ...extra], h.deps), 2, extra.join(' '));
    assert.equal(h.calls.length, 0, extra.join(' '));
  }
  const ok = harness();
  assert.equal(await listenCommand(['--as', 'walsh', '--ack', '7'], ok.deps), 0);
  assert.deepEqual(ok.calls.find((c) => c.method === 'POST').body, { agent_id: 'agent-walsh-id', seq: 7 });
});

test('a sign-in check that fails on the server reports that error, not "not logged in"', async () => {
  const h = harness();
  h.deps.token = '';
  h.deps.ensureCredentials = async () => ({ error: 'token_invalid', detail: 'Internal Server Error' });
  assert.equal(await listenCommand(['--as', 'walsh'], h.deps), 2);
  const said = h.stderr.join('\n');
  assert.doesNotMatch(said, /not logged in/);
  assert.match(said, /Internal Server Error/);
});

test('a 404 "Business not found" on the member lookup names the business, not a missing member', async () => {
  const handler = async (pathname) => (pathname.startsWith('/business/')
    ? { ok: false, status: 404, data: { detail: 'Business not found' } }
    : { ok: true, status: 200, data: { items: [], read_up_to: 0 } });
  const h = harness({ handler });
  assert.equal(await listenCommand(['--as', 'walsh'], h.deps), 2);
  assert.match(h.stderr.join('\n'), /no business called "atris-labs"/);
  assert.doesNotMatch(h.stderr.join('\n'), /no member called/);
  assert.ok(h.calls.every((c) => !c.pathname.includes('/inbox')));
});

test('the real server wording for a missing member ("Agent not found: x") still reads as a missing member', async () => {
  const handler = async () => ({ ok: false, status: 404, data: { detail: 'Agent not found: nobody' } });
  const h = harness({ handler });
  assert.equal(await listenCommand(['--as', 'nobody'], h.deps), 2);
  assert.match(h.stderr.join('\n'), /no member called "nobody"/);
});

test('every request uses a short timeout and no retry, so a run every minute never overlaps', async () => {
  const seen = [];
  const h = harness();
  const inner = h.deps.apiRequestJson;
  h.deps.apiRequestJson = async (p, o = {}) => { seen.push(o); return inner(p, o); };
  await listenCommand(['--as', 'walsh'], h.deps);
  await listenCommand(['--as', 'walsh', '--ack', '42'], h.deps);
  assert.ok(seen.length >= 4);
  for (const o of seen) {
    assert.ok(typeof o.timeoutMs === 'number' && o.timeoutMs <= 10000, `timeout ${o.timeoutMs}`);
    assert.equal(o.retries, 0);
  }
});

test('--watch says when 50 or more are waiting, once, instead of going quiet', async () => {
  const page = Array.from({ length: 50 }, (_, i) => ({ seq: i + 1, reason: 'mention', channel: 'general', content: `item ${i + 1}`, author_name: 'thorp', created_at: '2026-11-11T19:00:00Z' }));
  let round = 0;
  const handler = fakeServer({ overrides: { [`GET /swarlo/${LABS_ID}/inbox`]: () => ({ ok: true, status: 200, data: { items: page, read_up_to: 0 } }) } });
  const h = harness({ handler });
  h.deps.sleep = async () => { round += 1; };
  h.deps.keepGoing = () => round < 2;
  assert.equal(await listenCommand(['--as', 'walsh', '--watch'], h.deps), 0);
  const out = h.stdout.join('\n');
  assert.equal((out.match(/50\+ waiting/g) || []).length, 1, out);
  assert.match(out, /--ack 50/);
  assert.equal((out.match(/item 1\b/g) || []).length, 1, out);
});

// A real HTTP server for the end-to-end checks below. `route(req, body)`
// returns [status, data], or null to never answer.
async function withServer(route, fn) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, body });
      const answer = route(req, body);
      if (!answer) return;
      res.writeHead(answer[0], { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(answer[1]));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}/api`, seen);
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

const inboxRoute = (req) => {
  if (req.url === '/api/business/atris-labs/team/walsh') return [200, { agent_id: 'agent-walsh-id', name: 'walsh' }];
  if (req.method === 'GET' && req.url.startsWith('/api/swarlo/atris-labs/inbox?')) return [200, { items: ITEMS, read_up_to: 39 }];
  if (req.method === 'POST' && req.url === '/api/swarlo/atris-labs/inbox/ack') return [200, { read_up_to: 42 }];
  if (req.url === '/api/auth/validate') return [200, { valid: true, user: { id: 'u1' } }];
  return [404, { detail: 'Not Found' }];
};

test('one run is two requests (member, inbox) with no separate sign-in check when the token comes from env', async () => {
  await withServer(inboxRoute, async (api, seen) => {
    const env = { HOME: makeHome(), ATRIS_API_URL: api, ATRIS_TOKEN: TOKEN, ATRIS_BUSINESS: 'atris-labs' };
    const read = await runCli(['listen', '--as', 'walsh'], { cwd: makeDir('cwd-'), env });
    assert.equal(read.status, 0, read.stderr);
    assert.deepEqual(seen.map((s) => `${s.method} ${s.url.split('?')[0]}`), ['GET /api/business/atris-labs/team/walsh', 'GET /api/swarlo/atris-labs/inbox']);
    seen.length = 0;
    const ack = await runCli(['listen', '--as', 'walsh', '--ack', '42'], { cwd: makeDir('cwd-'), env });
    assert.equal(ack.status, 0, ack.stderr);
    assert.deepEqual(seen.map((s) => `${s.method} ${s.url}`), ['GET /api/business/atris-labs/team/walsh', 'POST /api/swarlo/atris-labs/inbox/ack']);
  });
});

test('a 500 from the sign-in check reports the server error and exits 2', async () => {
  const route = (req) => (req.url === '/api/auth/validate' ? [500, { detail: 'Internal Server Error' }] : inboxRoute(req));
  await withServer(route, async (api, seen) => {
    // A stored sign-in with no known expiry, so the CLI has to check it.
    const home = makeHome();
    fs.writeFileSync(path.join(home, '.atris', 'credentials.json'), JSON.stringify({ token: 'opaque-stored-token', email: 'a@example.com' }));
    const res = await runCli(['listen', '--as', 'walsh'], { cwd: makeDir('cwd-'), env: { HOME: home, ATRIS_API_URL: api, ATRIS_BUSINESS: 'atris-labs' } });
    assert.equal(res.status, 2, res.stderr);
    assert.doesNotMatch(res.stderr, /not logged in/);
    assert.match(res.stderr, /Internal Server Error/);
    assert.ok(seen.every((s) => !s.url.includes('/inbox')));
  });
});

test('network down reports the network error, not "not logged in", and gives up fast', async () => {
  const probe = http.createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const { port } = probe.address();
  await new Promise((r) => probe.close(r));
  const started = Date.now();
  const res = await runCli(['listen', '--as', 'walsh'], { cwd: makeDir('cwd-'), env: { HOME: makeHome(), ATRIS_API_URL: `http://127.0.0.1:${port}/api`, ATRIS_TOKEN: TOKEN, ATRIS_BUSINESS: 'atris-labs' } });
  assert.equal(res.status, 2, res.stderr);
  assert.doesNotMatch(res.stderr, /not logged in/);
  assert.match(res.stderr, /ECONNREFUSED|connect/i);
  assert.ok(Date.now() - started < 4000, `took ${Date.now() - started} ms`);
});

test('with the update check left on, no update notice reaches stdout (plain or --json)', async () => {
  await withServer(inboxRoute, async (api) => {
    const home = makeHome();
    // A cached "newer version" makes the notice print if the check runs.
    fs.writeFileSync(path.join(home, '.atris', '.update-check'), JSON.stringify({ lastCheck: new Date().toISOString(), latestVersion: '999.0.0' }));
    const env = { HOME: home, ATRIS_API_URL: api, ATRIS_TOKEN: TOKEN, ATRIS_BUSINESS: 'atris-labs', ATRIS_SKIP_UPDATE_CHECK: '', NO_UPDATE_NOTIFIER: '', ATRIS_AUTO_UPDATE: 'off' };
    const json = await runCli(['listen', '--as', 'walsh', '--json'], { cwd: makeDir('cwd-'), env });
    assert.equal(json.status, 0, json.stderr);
    assert.deepEqual(JSON.parse(json.stdout), { items: ITEMS, read_up_to: 39 });
    const plain = await runCli(['listen', '--as', 'walsh'], { cwd: makeDir('cwd-'), env });
    assert.equal(plain.status, 0, plain.stderr);
    assert.doesNotMatch(plain.stdout + plain.stderr, /update available|999\.0\.0/);
    assert.equal(plain.stdout.trim().split('\n').length, 3, plain.stdout);
  });
});

test('--watch --json stops on Ctrl-C with nothing but items on stdout', async () => {
  await withServer(inboxRoute, async (api) => {
    const env = { ...process.env, HOME: makeHome(), ATRIS_API_URL: api, ATRIS_TOKEN: TOKEN, ATRIS_BUSINESS: 'atris-labs', ATRIS_SKIP_UPDATE_CHECK: '1', ATRIS_AGENT: '' };
    const child = spawn(process.execPath, [cliPath, 'listen', '--as', 'walsh', '--watch', '--json'], { cwd: makeDir('cwd-'), env });
    let stdout = '';
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    const closed = new Promise((r) => child.on('close', (status) => r(status)));
    await new Promise((resolve) => child.stdout.on('data', (d) => { stdout += d; if (stdout.split('\n').length > 2) resolve(); }));
    child.kill('SIGINT');
    const status = await closed;
    assert.equal(status, 0);
    const lines = stdout.trim().split('\n');
    assert.deepEqual(lines.map((l) => JSON.parse(l).seq), [40, 42]);
    assert.match(stderr, /stopped listening/);
  });
});

test('a stored sign-in that is not near expiry is used without a separate check', async () => {
  await withServer(inboxRoute, async (api, seen) => {
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const jwt = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: 'u1', exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
    const home = makeHome();
    fs.writeFileSync(path.join(home, '.atris', 'credentials.json'), JSON.stringify({ token: jwt, email: 'a@example.com' }));
    const res = await runCli(['listen', '--as', 'walsh'], { cwd: makeDir('cwd-'), env: { HOME: home, ATRIS_API_URL: api, ATRIS_BUSINESS: 'atris-labs' } });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(seen.length, 2, seen.map((s) => s.url).join(', '));
    assert.ok(seen.every((s) => !s.url.includes('/auth/')));
  });
});
