'use strict';

// atris channel: the team's shared channels on the hosted server, by name.
// Every test here talks to a fake server; nothing touches the network.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { channelCommand, resolveChannelBusiness } = require('../commands/channel');
const { knownCommands } = require('../lib/known-commands');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-channel-'));
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

const TOKEN = 'secret-tok-9f8e7d6c5b4a';
const LABS_ID = '5db129d0-aa32-46eb-81ae-29bb86f67b0f';
const NOW = Date.parse('2026-11-11T20:00:00Z');

// A home folder with a registered business list, and a folder with no binding.
function makeHome(registry) {
  const home = fs.mkdtempSync(path.join(scratch, 'home-'));
  fs.mkdirSync(path.join(home, '.atris'), { recursive: true });
  if (registry) fs.writeFileSync(path.join(home, '.atris', 'businesses.json'), JSON.stringify(registry));
  return home;
}
function makeFolder(binding) {
  const dir = fs.mkdtempSync(path.join(scratch, 'cwd-'));
  if (binding) {
    fs.mkdirSync(path.join(dir, '.atris'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.atris', 'business.json'), JSON.stringify(binding));
  }
  return dir;
}

const REGISTRY = {
  'atris-labs': { business_id: LABS_ID, name: 'Atris Labs', slug: 'atris-labs' },
  pallet: { business_id: '789ff587-e197-48c4-b5b8-0acb5af783ff', name: 'Pallet', slug: 'pallet' },
};

const POSTS = {
  general: [
    { post_id: 'p3', content: 'second hello', kind: 'message', channel: 'general', member_name: 'Grok', created_at: '2026-11-11T19:50:00Z' },
    { post_id: 'p2', content: 'first hello', kind: 'message', channel: 'general', member_name: 'Muse', created_at: '2026-11-11T18:00:00Z' },
  ],
  experiments: [
    { post_id: 'p9', content: 'try the smoke test', kind: 'message', channel: 'experiments', member_name: 'Walsh', task_key: 'smoke-1', created_at: '2026-11-11T17:00:00Z' },
  ],
  outreach: [],
};

const MEMBERS = { walsh: 'agent-walsh-id', amara: 'agent-amara-id' };

function fakeServer(overrides = {}) {
  return async (pathname, options = {}) => {
    const method = options.method || 'GET';
    const key = `${method} ${pathname}`;
    if (overrides[key]) return overrides[key](options);
    const base = `/swarlo/${LABS_ID}`;
    if (key === `GET ${base}/channels`) return { ok: true, status: 200, data: { channels: Object.keys(POSTS) } };
    const read = pathname.match(/^\/swarlo\/[^/]+\/channels\/([^/]+)\/posts\?limit=(\d+)$/);
    if (method === 'GET' && read) {
      const posts = (POSTS[decodeURIComponent(read[1])] || []).slice(0, Number(read[2]));
      return { ok: true, status: 200, data: { channel: read[1], count: posts.length, posts } };
    }
    if (key === `GET ${base}/claims`) return { ok: true, status: 200, data: { count: 0, claims: [] } };
    const team = pathname.match(/^\/business\/[^/]+\/team\/([^/]+)$/);
    if (method === 'GET' && team) {
      return MEMBERS[team[1]]
        ? { ok: true, status: 200, data: { agent_id: MEMBERS[team[1]], name: team[1] } }
        : { ok: false, status: 404, data: { detail: 'Team member not found' } };
    }
    if (method === 'POST') return { ok: true, status: 201, data: { post_id: 'new1', ...options.body } };
    return { ok: false, status: 404, data: { detail: 'Not Found' } };
  };
}

function harness({ handler = fakeServer(), env = {}, cwd, home } = {}) {
  const stdout = [];
  const stderr = [];
  const calls = [];
  return {
    stdout,
    stderr,
    calls,
    all: () => stdout.concat(stderr).join('\n'),
    deps: {
      token: TOKEN,
      env: { ATRIS_BUSINESS: 'atris-labs', ...env },
      cwd: cwd || makeFolder(),
      homeDir: home || makeHome(REGISTRY),
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

test('channel is a known command and shows in help --all', async () => {
  assert.ok(knownCommands.includes('channel'));
  const res = await runCli(['help', '--all'], { cwd: makeFolder(), env: { HOME: makeHome() } });
  assert.match(res.stdout, /\n\s+channel\s+-/);
});

// ── which business ──────────────────────────────────────────

test('business: --business wins over env, binding, and the registered list', () => {
  const cwd = makeFolder({ business_id: 'bound-id', slug: 'bound' });
  const got = resolveChannelBusiness({ business: 'pallet' }, { env: { ATRIS_BUSINESS: 'atris-labs' }, cwd, homeDir: makeHome(REGISTRY) });
  assert.equal(got.id, '789ff587-e197-48c4-b5b8-0acb5af783ff');
  assert.equal(got.slug, 'pallet');
});

test('business: env ATRIS_BUSINESS wins over the folder binding', () => {
  const cwd = makeFolder({ business_id: 'bound-id', slug: 'bound' });
  const got = resolveChannelBusiness({}, { env: { ATRIS_BUSINESS: 'atris-labs' }, cwd, homeDir: makeHome(REGISTRY) });
  assert.equal(got.id, LABS_ID);
});

test('business: the folder binding wins over the registered list', () => {
  const cwd = makeFolder({ business_id: 'bound-id', slug: 'bound' });
  const nested = path.join(cwd, 'a', 'b');
  fs.mkdirSync(nested, { recursive: true });
  const got = resolveChannelBusiness({}, { env: {}, cwd: nested, homeDir: makeHome(REGISTRY) });
  assert.deepEqual([got.id, got.slug], ['bound-id', 'bound']);
});

test('business: one registered business is used without asking', () => {
  const home = makeHome({ 'atris-labs': REGISTRY['atris-labs'] });
  const got = resolveChannelBusiness({}, { env: {}, cwd: makeFolder(), homeDir: home });
  assert.deepEqual([got.id, got.slug], [LABS_ID, 'atris-labs']);
});

test('business: several registered and nothing chosen refuses in one plain sentence', () => {
  const got = resolveChannelBusiness({}, { env: {}, cwd: makeFolder(), homeDir: makeHome(REGISTRY) });
  assert.ok(got.error);
  assert.match(got.error, /--business <slug>/);
  assert.match(got.error, /ATRIS_BUSINESS/);
  assert.match(got.error, /atris-labs, pallet/);
  assert.equal(got.error.split('\n').length, 1);
});

test('business: a slug not on this computer goes to the server as is; a uuid is kept', () => {
  const home = makeHome();
  assert.deepEqual(resolveChannelBusiness({ business: 'some-team' }, { env: {}, cwd: makeFolder(), homeDir: home }),
    { id: 'some-team', slug: 'some-team', name: 'some-team' });
  assert.equal(resolveChannelBusiness({ business: LABS_ID }, { env: {}, cwd: makeFolder(), homeDir: home }).id, LABS_ID);
});

// ── each verb, the right path and body ──────────────────────

test('atris channel: latest few posts from every channel, quiet ones named once', async () => {
  const h = harness();
  assert.equal(await channelCommand([], h.deps), 0);
  const paths = h.calls.map((c) => `${c.method} ${c.pathname}`);
  assert.equal(paths[0], `GET /swarlo/${LABS_ID}/channels`);
  // always the server's most: it filters by channel after taking limit x 3 posts
  assert.ok(paths.includes(`GET /swarlo/${LABS_ID}/channels/general/posts?limit=50`));
  const out = h.stdout.join('\n');
  assert.match(out, /#general/);
  assert.match(out, /Grok\s+10 min ago\s+second hello/);
  // newest last inside a channel
  assert.ok(out.indexOf('first hello') < out.indexOf('second hello'));
  assert.match(out, /quiet: #outreach/);
  for (const c of h.calls) assert.equal(c.token, TOKEN);
});

test('atris channel <name>: reads that channel, newest last', async () => {
  const h = harness();
  assert.equal(await channelCommand(['general'], h.deps), 0);
  assert.equal(h.calls.at(-1).pathname, `/swarlo/${LABS_ID}/channels/general/posts?limit=50`);
  const out = h.stdout.join('\n');
  assert.ok(out.indexOf('first hello') < out.indexOf('second hello'));
});

test('atris channel <name> --json gives the server reply', async () => {
  const h = harness();
  assert.equal(await channelCommand(['general', '--json', '--limit', '1'], h.deps), 0);
  const reply = JSON.parse(h.stdout.join(''));
  assert.deepEqual([reply.count, reply.posts[0].content], [1, 'second hello']);
});

test('atris channel <name> "message": posts it', async () => {
  const h = harness();
  assert.equal(await channelCommand(['general', 'hello team'], h.deps), 0);
  const post = h.calls.find((c) => c.method === 'POST');
  assert.equal(post.pathname, `/swarlo/${LABS_ID}/channels/general/posts`);
  assert.deepEqual(post.body, { content: 'hello team' });
  assert.match(h.stdout.join('\n'), /posted to #general/);
});

test('atris channel <name> "what to do" --task <key>: posts a task others can claim', async () => {
  const h = harness();
  assert.equal(await channelCommand(['experiments', 'try it', '--task', 'smoke-2'], h.deps), 0);
  const post = h.calls.find((c) => c.method === 'POST');
  assert.equal(post.pathname, `/swarlo/${LABS_ID}/channels/experiments/posts`);
  assert.deepEqual(post.body, { content: 'try it', task_key: 'smoke-2' });
  assert.match(h.stdout.join('\n'), /posted task smoke-2 to #experiments/);
});

// ── members post as themselves ──────────────────────────────

test('--as <member> looks the member up and sends its agent id with the post', async () => {
  const h = harness();
  assert.equal(await channelCommand(['general', 'hello team', '--as', 'walsh'], h.deps), 0);
  assert.ok(h.calls.some((c) => c.method === 'GET' && c.pathname === `/business/${LABS_ID}/team/walsh`));
  const post = h.calls.find((c) => c.method === 'POST');
  assert.deepEqual(post.body, { content: 'hello team', agent_id: 'agent-walsh-id' });
  assert.match(h.stdout.join('\n'), /posted to #general as walsh/);
});

test('ATRIS_AGENT is the default member for claim and done; --as wins over it', async () => {
  const h = harness({ env: { ATRIS_AGENT: 'amara' } });
  assert.equal(await channelCommand(['claim', 'smoke-1'], h.deps), 0);
  assert.equal(h.calls.find((c) => c.method === 'POST').body.agent_id, 'agent-amara-id');
  assert.match(h.stdout.join('\n'), /claimed smoke-1 in #experiments as amara/);
  const h2 = harness({ env: { ATRIS_AGENT: 'amara' } });
  assert.equal(await channelCommand(['done', 'smoke-1', 'finished', '--as', 'walsh'], h2.deps), 0);
  const report = h2.calls.find((c) => c.method === 'POST');
  assert.deepEqual(report.body, { task_key: 'smoke-1', status: 'done', content: 'finished', agent_id: 'agent-walsh-id' });
});

test('an unknown member is refused in one sentence and nothing is posted as the person', async () => {
  for (const args of [['general', 'hi', '--as', 'ghost'], ['claim', 'smoke-1', '--as', 'ghost'], ['blocked', 'smoke-1', 'why', '--as', 'ghost']]) {
    const h = harness();
    assert.equal(await channelCommand(args, h.deps), 1);
    assert.equal(h.calls.filter((c) => c.method === 'POST').length, 0, args.join(' '));
    const err = h.stderr.join('\n');
    assert.match(err, /no member called "ghost" in atris-labs, so nothing was sent/);
    assert.equal(err.split('\n').length, 1);
  }
  const env = harness({ env: { ATRIS_AGENT: 'ghost' } });
  assert.equal(await channelCommand(['general', 'hi'], env.deps), 1);
  assert.equal(env.calls.filter((c) => c.method === 'POST').length, 0);
});

test('reads never look up a member, even with ATRIS_AGENT set', async () => {
  const h = harness({ env: { ATRIS_AGENT: 'walsh' } });
  assert.equal(await channelCommand(['general'], h.deps), 0);
  assert.ok(!h.calls.some((c) => c.pathname.includes('/team/')));
});

test('posting to a channel that does not exist is refused unless --new', async () => {
  const h = harness();
  assert.equal(await channelCommand(['genral', 'hello'], h.deps), 1);
  assert.equal(h.calls.filter((c) => c.method === 'POST').length, 0);
  assert.match(h.stderr.join('\n'), /no channel named "genral".*general/);
  const h2 = harness();
  assert.equal(await channelCommand(['launch', 'hello', '--new'], h2.deps), 0);
  assert.equal(h2.calls.find((c) => c.method === 'POST').pathname, `/swarlo/${LABS_ID}/channels/launch/posts`);
});

test('atris channel list: just the names', async () => {
  const h = harness();
  assert.equal(await channelCommand(['list'], h.deps), 0);
  assert.equal(h.stdout.join('\n'), '#general\n#experiments\n#outreach');
});

test('claim finds the channel that carries the task key, then claims there', async () => {
  const h = harness();
  assert.equal(await channelCommand(['claim', 'smoke-1', 'on it'], h.deps), 0);
  const claim = h.calls.find((c) => c.method === 'POST');
  assert.equal(claim.pathname, `/swarlo/${LABS_ID}/channels/experiments/claim`);
  assert.deepEqual(claim.body, { task_key: 'smoke-1', content: 'on it' });
  assert.match(h.stdout.join('\n'), /claimed smoke-1 in #experiments/);
});

test('claim on a task key no channel carries gives a plain error and claims nothing', async () => {
  const h = harness();
  assert.equal(await channelCommand(['claim', 'nope-404'], h.deps), 1);
  assert.equal(h.calls.filter((c) => c.method === 'POST').length, 0);
  const err = h.stderr.join('\n');
  assert.match(err, /no channel has a task called "nope-404"/);
  assert.match(err, /--channel <name>/);
  assert.equal(err.split('\n').length, 1);
});

test('claim with --channel skips the search', async () => {
  const h = harness();
  assert.equal(await channelCommand(['claim', 'fresh-key', '--channel', 'ops'], h.deps), 0);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].pathname, `/swarlo/${LABS_ID}/channels/ops/claim`);
  assert.deepEqual(h.calls[0].body, { task_key: 'fresh-key', content: 'claimed fresh-key' });
});

test('claim already taken says who has it', async () => {
  const h = harness({
    handler: fakeServer({
      [`POST /swarlo/${LABS_ID}/channels/experiments/claim`]: () => ({
        ok: false, status: 409, data: { detail: { claimed: false, conflict: true, message: 'Already claimed by Grok' } },
      }),
    }),
  });
  assert.equal(await channelCommand(['claim', 'smoke-1'], h.deps), 1);
  assert.match(h.stderr.join('\n'), /Already claimed by Grok/);
});

test('done uses the open claim to find the channel and reports there', async () => {
  const h = harness({
    handler: fakeServer({
      [`GET /swarlo/${LABS_ID}/claims`]: () => ({
        ok: true, status: 200, data: { count: 1, claims: [{ task_key: 'k7', channel: 'ops', kind: 'claim', status: 'open' }] },
      }),
    }),
  });
  assert.equal(await channelCommand(['done', 'k7', 'shipped it'], h.deps), 0);
  const report = h.calls.find((c) => c.method === 'POST');
  assert.equal(report.pathname, `/swarlo/${LABS_ID}/channels/ops/report`);
  assert.deepEqual(report.body, { task_key: 'k7', status: 'done', content: 'shipped it' });
  assert.match(h.stdout.join('\n'), /k7 is done in #ops/);
});

test('failed and blocked report with their own status; a summary is required', async () => {
  for (const status of ['failed', 'blocked']) {
    const h = harness();
    assert.equal(await channelCommand([status, 'smoke-1', 'why'], h.deps), 0);
    const report = h.calls.find((c) => c.method === 'POST');
    assert.equal(report.pathname, `/swarlo/${LABS_ID}/channels/experiments/report`);
    assert.equal(report.body.status, status);
  }
  const h = harness();
  assert.equal(await channelCommand(['done', 'smoke-1'], h.deps), 1);
  assert.equal(h.calls.length, 0);
  assert.match(h.stderr.join('\n'), /needs a summary/);
});

test('reserved words cannot be read or posted as channel names', async () => {
  const h = harness();
  assert.equal(await channelCommand(['claim'], h.deps), 1);
  assert.equal(h.calls.length, 0);
  assert.match(h.stderr.join('\n'), /claim needs a task key/);
});

test('unknown flags stop before any request', async () => {
  const h = harness();
  assert.equal(await channelCommand(['general', 'hi', '--yolo'], h.deps), 1);
  assert.equal(h.calls.length, 0);
});

test('not signed in says so plainly', async () => {
  const h = harness();
  h.deps.token = '';
  h.deps.ensureCredentials = async () => ({ error: 'not_logged_in' });
  assert.equal(await channelCommand(['general'], h.deps), 1);
  assert.match(h.stderr.join('\n'), /not logged in/);
});

test('the token never appears in any output, even when the server echoes it', async () => {
  const echo = () => ({ ok: false, status: 500, data: { detail: `bad token ${TOKEN}` } });
  const runs = [[], ['general'], ['general', 'hi'], ['claim', 'smoke-1'], ['done', 'smoke-1', 'ok'], ['list'], ['general', '--json']];
  for (const args of runs) {
    const ok = harness();
    await channelCommand(args, ok.deps);
    assert.ok(!ok.all().includes(TOKEN), `token leaked on ${args.join(' ')}`);
    const bad = harness({ handler: echo });
    await channelCommand(args, bad.deps);
    assert.ok(!bad.all().includes(TOKEN), `token leaked on failing ${args.join(' ')}`);
    assert.ok(bad.stderr.length > 0, `no error shown on failing ${args.join(' ')}`);
  }
});

// ── the real CLI against a local fake server ────────────────

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

test('the installed command reads and posts through a real HTTP server with the stored sign-in', async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
      const send = (code, data) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
      if (req.url === '/api/auth/validate') return send(200, { valid: true, user: { id: 'u1' } });
      if (req.url === '/api/swarlo/atris-labs/channels') return send(200, { channels: ['general'] });
      if (req.url.startsWith('/api/swarlo/atris-labs/channels/general/posts?')) return send(200, { channel: 'general', count: 2, posts: POSTS.general });
      if (req.method === 'POST' && req.url === '/api/swarlo/atris-labs/channels/general/posts') return send(201, { post_id: 'n1' });
      return send(404, { detail: 'Not Found' });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    // A home with no business list: the slug goes to the server as is.
    const home = makeHome();
    const env = { HOME: home, ATRIS_API_URL: `http://127.0.0.1:${port}/api`, ATRIS_TOKEN: TOKEN };
    const read = await runCli(['channel', 'general', '--business', 'atris-labs'], { cwd: makeFolder(), env });
    assert.equal(read.status, 0, read.stderr);
    assert.match(read.stdout, /Muse .* first hello\n.*Grok .* second hello/);
    const post = await runCli(['channel', 'general', 'hi from the test'], { cwd: makeFolder(), env: { ...env, ATRIS_BUSINESS: 'atris-labs' } });
    assert.equal(post.status, 0, post.stderr);
    const sent = seen.find((s) => s.method === 'POST' && s.url.endsWith('/posts'));
    assert.deepEqual(JSON.parse(sent.body), { content: 'hi from the test' });
    for (const s of seen) assert.equal(s.auth, `Bearer ${TOKEN}`);
    for (const r of [read, post]) assert.ok(!(r.stdout + r.stderr).includes(TOKEN));
  } finally {
    server.close();
  }
});
