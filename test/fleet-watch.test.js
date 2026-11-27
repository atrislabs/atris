'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

// commands/fleet.js and lib/swarlo-members.js resolve ~/.swarlo paths from
// os.homedir() at call time, so HOME must point at a scratch dir before the
// requires below.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-fleet-watch-'));
const fakeHome = path.join(sandbox, 'home');
fs.mkdirSync(fakeHome, { recursive: true });

const SWARLO_ENV = [
  'SWARLO_SERVER', 'SWARLO_HUB', 'SWARLO_HUB_ID', 'SWARLO_HUB_URL',
  'SWARLO_CONFIG', 'SWARLO_TOKEN', 'SWARLO_API_KEY', 'SWARLO_MEMBER_ID',
  'SWARLO_INVITE_TOKEN',
];
const realEnv = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
for (const key of SWARLO_ENV) realEnv[key] = process.env[key];
const realCwd = process.cwd();
const realExitCode = process.exitCode;
process.env.HOME = fakeHome;
process.env.USERPROFILE = fakeHome;
for (const key of SWARLO_ENV) delete process.env[key];

const { fleet, parseFleetWatchArgs } = require('../commands/fleet');
const watch = require('../lib/fleet-watch');
const swarlo = require('../lib/swarlo-members');

// ── helpers ──────────────────────────────────────────────

function isoAgo(ms) {
  return new Date(Date.now() - ms).toISOString();
}

// Seed a launched member the way `fleet up` leaves it: a per-member identity
// under ~/.swarlo/identities plus a row in fleet-launched.json.
function launchMember({ hub, name, server, channels = ['common'], launchedAt, memberName } = {}) {
  swarlo.saveIdentity(swarlo.identityDirFor({ server, hub, member: name }), {
    server,
    hub,
    member_id: name,
    member_name: memberName || name,
    member_type: 'agent',
    token: `key-${name}`,
  });
  const launched = swarlo.loadLaunched();
  if (!launched[hub]) launched[hub] = {};
  launched[hub][name] = {
    server,
    engine: 'claude',
    channels,
    member_name: memberName || name,
    launched_at: launchedAt || isoAgo(60 * 60 * 1000),
  };
  swarlo.saveLaunched(launched);
  return launched;
}

function boardPost(over = {}) {
  return {
    post_id: `post-${Math.random().toString(36).slice(2, 10)}`,
    channel: 'common',
    member_id: 'scout',
    member_name: 'scout',
    member_type: 'agent',
    content: 'hello board',
    kind: 'message',
    status: 'open',
    created_at: new Date().toISOString(),
    ...over,
  };
}

// A stub Swarlo hub. `board` maps channel -> posts, `mine`/`unclaimed` map
// member/channel -> task rows. failRegister makes /api/register 403.
async function startHub({ board = {}, mine = {}, unclaimed = {}, failRegister = false, down = false } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let parsed = null;
      try { parsed = body ? JSON.parse(body) : null; } catch { parsed = null; }
      requests.push({ method: req.method, url: req.url, auth: req.headers.authorization || '', body: parsed });
      const send = (status, obj) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (req.url === '/api/health') return send(200, { status: 'ok' });
      if (req.url === '/api/register' && req.method === 'POST') {
        if (failRegister) return send(403, { error: 'invite required' });
        return send(201, { member_id: parsed.member_id, api_key: `key-${parsed.member_id}`, hub_id: parsed.hub_id });
      }
      const postsMatch = req.url.match(/^\/api\/([^/]+)\/channels\/([^/]+)\/posts/);
      if (postsMatch && req.method === 'GET') {
        const channel = decodeURIComponent(postsMatch[2]);
        return send(200, { channel, count: (board[channel] || []).length, posts: board[channel] || [] });
      }
      if (postsMatch && req.method === 'POST') {
        const channel = decodeURIComponent(postsMatch[2]);
        if (!Array.isArray(board[channel])) board[channel] = [];
        const post = boardPost({ post_id: `nudge-${board[channel].length}`, channel, member_id: 'fleet-watch', member_name: 'Fleet Watch', content: parsed.content, kind: parsed.kind });
        board[channel].unshift(post);
        return send(201, post);
      }
      const mineMatch = req.url.match(/^\/api\/([^/]+)\/mine\/([^/?]+)/);
      if (mineMatch && req.method === 'GET') {
        const member = decodeURIComponent(mineMatch[2]);
        const tasks = mine[member] || [];
        return send(200, { member_id: member, count: tasks.length, tasks });
      }
      const unclaimedMatch = req.url.match(/^\/api\/([^/]+)\/unclaimed/);
      if (unclaimedMatch && req.method === 'GET') {
        const channel = new URL(req.url, 'http://x').searchParams.get('channel') || '';
        const tasks = unclaimed[channel] || [];
        return send(200, { count: tasks.length, tasks });
      }
      send(404, { error: 'not found' });
    });
  });
  if (down) return { server: null, url: 'http://127.0.0.1:1', requests };
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}`, requests };
}

async function capture(fn) {
  const out = [];
  const err = [];
  const orig = { log: console.log, error: console.error };
  console.log = (...a) => out.push(a.join(' '));
  console.error = (...a) => err.push(a.join(' '));
  try {
    await fn();
  } finally {
    console.log = orig.log;
    console.error = orig.error;
  }
  return { stdout: out.join('\n'), stderr: err.join('\n') };
}

function resetSwarlo() {
  fs.rmSync(path.join(fakeHome, '.swarlo'), { recursive: true, force: true });
}

test.beforeEach(resetSwarlo);

test.after(() => {
  process.chdir(realCwd);
  process.exitCode = realExitCode;
  for (const [key, value] of Object.entries(realEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(sandbox, { recursive: true, force: true });
});

// ── arg parsing ──────────────────────────────────────────

test('parseFleetWatchArgs reads interval, once, json, filters, and a bare seconds arg', () => {
  const parsed = parseFleetWatchArgs(['--interval', '45', '--once', '--json', '--hub', 'testhub', '--server=http://x:1']);
  assert.equal(parsed.intervalSec, 45);
  assert.equal(parsed.once, true);
  assert.equal(parsed.json, true);
  assert.equal(parsed.hub, 'testhub');
  assert.equal(parsed.server, 'http://x:1');

  const bare = parseFleetWatchArgs(['20', '--interval=5']);
  assert.equal(bare.intervalSec, 5, '--interval= wins over the bare number');
  assert.equal(parseFleetWatchArgs(['20']).intervalSec, 20);
  assert.equal(parseFleetWatchArgs([]).intervalSec, 30);
});

// ── pollOnce unit coverage (injected request) ─────────────

// A request stub shaped like swarloRequest: (method, url, body, headers).
function fakeRequest(handler) {
  const calls = [];
  const fn = async (method, url, body, headers = {}) => {
    calls.push({ method, url, body, headers });
    return handler(method, url, body, headers);
  };
  fn.calls = calls;
  return fn;
}

function launchedFixture(server, { launchedAt } = {}) {
  return {
    testhub: {
      builder: {
        server,
        engine: 'claude',
        channels: ['common'],
        member_name: 'builder',
        launched_at: launchedAt || isoAgo(60 * 60 * 1000),
      },
    },
  };
}

test('pollOnce nudges once per new work set and stays silent while it is unchanged', async () => {
  const mention = boardPost({ content: '@builder please look at this' });
  const request = fakeRequest(async (method, url) => {
    if (url.includes('/posts?')) return { status: 200, data: { posts: [mention] } };
    if (url.includes('/mine/')) return { status: 200, data: { tasks: [] } };
    if (url.includes('/unclaimed')) return { status: 200, data: { tasks: [] } };
    if (url.endsWith('/posts') && method === 'POST') return { status: 201, data: { post_id: 'n1' } };
    if (url.endsWith('/api/register')) return { status: 201, data: { api_key: 'key-fleet-watch' } };
    return { status: 404, data: {} };
  });
  // Identity files so hubReadToken and watcherToken resolve without a hub.
  const home = fs.mkdtempSync(path.join(sandbox, 'home-'));
  swarlo.saveIdentity(swarlo.identityDirFor({ server: 'http://hub:1', hub: 'testhub', member: 'builder' }, home), {
    server: 'http://hub:1', hub: 'testhub', member_id: 'builder', token: 'key-builder',
  });
  const launched = launchedFixture('http://hub:1');

  const first = await watch.pollOnce({ launched, state: {}, home, request, now: '2026-01-01T00:00:00.000Z' });
  const nudges = first.events.filter((e) => e.type === 'nudge');
  assert.equal(nudges.length, 1);
  assert.equal(nudges[0].member, 'builder');
  assert.equal(nudges[0].pending, 1);
  const nudgePost = request.calls.find((c) => c.method === 'POST' && c.url.endsWith('/posts'));
  assert.ok(nudgePost, 'a nudge post was made');
  assert.match(nudgePost.body.content, /@builder fleet watch:/);
  assert.equal(nudgePost.body.kind, 'message');

  // Same work, next poll inside the remind window: signature unchanged, no ring.
  const second = await watch.pollOnce({ launched, state: first.state, home, request, now: '2026-01-01T00:00:30.000Z' });
  assert.equal(second.events.filter((e) => e.type === 'nudge').length, 0);
  assert.equal(request.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/posts')).length, 1);

  // Same work past the remind window: it rings again.
  const third = await watch.pollOnce({
    launched, state: second.state, home, request,
    now: new Date(Date.parse('2026-01-01T00:00:30.000Z') + watch.NUDGE_REMIND_MS + 1000).toISOString(),
  });
  assert.equal(third.events.filter((e) => e.type === 'nudge').length, 1);
});

test('pollOnce drops a member that left the launched list', async () => {
  const home = fs.mkdtempSync(path.join(sandbox, 'home-'));
  const request = fakeRequest(async () => ({ status: 200, data: { posts: [], tasks: [] } }));
  const state = { testhub: { builder: { server: 'http://hub:1', since: '2026-01-01T00:00:00.000Z', signature: '', nudged_at: '', error: '', nudge_error: '' } } };
  const out = await watch.pollOnce({ launched: {}, state, home, request, now: '2026-01-01T00:01:00.000Z' });
  assert.equal(out.events.length, 1);
  assert.equal(out.events[0].type, 'dropped');
  assert.equal(out.events[0].member, 'builder');
  assert.equal(out.state.testhub, undefined, 'empty hub bucket removed');
});

test('pollOnce reports a hub that cannot be read once, then stays quiet', async () => {
  const home = fs.mkdtempSync(path.join(sandbox, 'home-'));
  swarlo.saveIdentity(swarlo.identityDirFor({ server: 'http://hub:1', hub: 'testhub', member: 'builder' }, home), {
    server: 'http://hub:1', hub: 'testhub', member_id: 'builder', token: 'key-builder',
  });
  const request = fakeRequest(async () => { throw new Error('connect ECONNREFUSED'); });
  const launched = launchedFixture('http://hub:1');

  const first = await watch.pollOnce({ launched, state: {}, home, request, now: '2026-01-01T00:00:00.000Z' });
  assert.equal(first.events.filter((e) => e.type === 'error').length, 1);
  assert.match(first.events[0].reason, /hub read failed/);

  const second = await watch.pollOnce({ launched, state: first.state, home, request, now: '2026-01-01T00:00:30.000Z' });
  assert.equal(second.events.length, 0, 'same failure is not re-reported');
  // The watermark held, so posts missed while the hub was down still count later.
  const keptSince = second.state.testhub.builder.since;
  assert.equal(keptSince, first.state.testhub.builder.since);
});

// ── command level: fleet watch --once against a stub hub ──

test('fleet watch --once registers the watcher, posts an @mention nudge, and dedups the next pass', async () => {
  const hub = await startHub({
    board: { common: [boardPost({ content: '@builder can you check the deploy?' })] },
  });
  launchMember({ hub: 'testhub', name: 'builder', server: hub.url });
  const root = fs.mkdtempSync(path.join(sandbox, 'ws-'));
  fs.mkdirSync(path.join(root, 'atris', 'team', 'builder'), { recursive: true });
  fs.writeFileSync(path.join(root, 'atris', 'team', 'builder', 'MEMBER.md'), '---\nname: builder\n---\n# builder\n');
  process.chdir(root);
  process.exitCode = undefined;
  try {
    const first = await capture(() => fleet(['watch', '--once']));
    assert.match(first.stdout, /builder nudged on testhub \(#common\)/);

    const registers = hub.requests.filter((r) => r.url === '/api/register');
    assert.equal(registers.length, 1);
    assert.equal(registers[0].body.member_id, 'fleet-watch');
    assert.equal(registers[0].body.member_type, 'agent');

    const nudges = hub.requests.filter((r) => r.method === 'POST' && r.url.endsWith('/channels/common/posts'));
    assert.equal(nudges.length, 1);
    assert.equal(nudges[0].auth, 'Bearer key-fleet-watch', 'nudge posts as the watcher');
    assert.match(nudges[0].body.content, /@builder fleet watch:/);
    assert.equal(nudges[0].body.kind, 'message');
    assert.equal(JSON.stringify(nudges[0].body).includes('key-builder'), false);

    // The awake switch flipped, same switch `atris wake` uses.
    const switches = JSON.parse(fs.readFileSync(path.join(root, '.atris', 'state', 'member-switches.json'), 'utf8'));
    assert.equal(switches.members.builder.awake, true);

    // Watch state persisted with the pending signature.
    const state = watch.loadWatchState();
    assert.ok(state.testhub.builder.signature.includes('post:'), 'signature tracks pending ids');

    // Second pass inside the remind window: same work, no second ring.
    const second = await capture(() => fleet(['watch', '--once']));
    assert.equal(second.stdout, '', 'silent while the same work waits');
    assert.equal(hub.requests.filter((r) => r.method === 'POST' && r.url.endsWith('/posts')).length, 1);
  } finally {
    process.exitCode = undefined;
    hub.server.close();
  }
});

test('fleet watch --once is silent when a launched member has no work', async () => {
  const hub = await startHub({ board: { common: [] } });
  launchMember({ hub: 'testhub', name: 'builder', server: hub.url });
  process.exitCode = undefined;
  try {
    const { stdout } = await capture(() => fleet(['watch', '--once']));
    assert.equal(stdout, '');
    assert.equal(hub.requests.filter((r) => r.method === 'POST').length, 0, 'no posts when idle');
  } finally {
    process.exitCode = undefined;
    hub.server.close();
  }
});

test('fleet watch --once --json reports members and events as JSON without tokens', async () => {
  const hub = await startHub({
    mine: { builder: [{ post_id: 't1', task_key: 'task:fix', content: 'assigned work', kind: 'claim', status: 'open' }] },
  });
  launchMember({ hub: 'testhub', name: 'builder', server: hub.url });
  process.exitCode = undefined;
  try {
    const { stdout } = await capture(() => fleet(['watch', '--once', '--json']));
    const payload = JSON.parse(stdout);
    assert.equal(payload.members.length, 1);
    assert.equal(payload.members[0].member, 'builder');
    assert.equal(payload.members[0].pending, 1);
    assert.equal(payload.events[0].type, 'nudge');
    assert.equal(JSON.stringify(payload).includes('key-builder'), false);
    assert.equal(JSON.stringify(payload).includes('key-fleet-watch'), false);
  } finally {
    process.exitCode = undefined;
    hub.server.close();
  }
});

test('fleet watch --once falls back to the member token when the hub refuses watcher registration', async () => {
  const hub = await startHub({
    failRegister: true,
    board: { common: [boardPost({ content: '@builder ping' })] },
  });
  launchMember({ hub: 'testhub', name: 'builder', server: hub.url });
  process.exitCode = undefined;
  try {
    const { stdout } = await capture(() => fleet(['watch', '--once']));
    assert.match(stdout, /builder nudged on testhub/);
    const nudges = hub.requests.filter((r) => r.method === 'POST' && r.url.endsWith('/posts'));
    assert.equal(nudges.length, 1);
    assert.equal(nudges[0].auth, 'Bearer key-builder', 'member token is the fallback author');
  } finally {
    process.exitCode = undefined;
    hub.server.close();
  }
});

test('fleet watch --once prints No launched members when the list is empty', async () => {
  process.exitCode = undefined;
  const { stdout } = await capture(() => fleet(['watch', '--once']));
  assert.match(stdout, /No launched members/);
});
