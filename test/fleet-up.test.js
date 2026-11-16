'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

// commands/fleet.js resolves ~/.swarlo paths from os.homedir() at call time,
// so HOME must point at a scratch dir before the require below.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-fleet-up-'));
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

const { fleet, parseFleetMemberArgs } = require('../commands/fleet');
const swarlo = require('../lib/swarlo-members');

// ── helpers ──────────────────────────────────────────────

function makeWorkspace(members, { roster = {}, engines = ['claude', 'codex'] } = {}) {
  const root = fs.mkdtempSync(path.join(sandbox, 'ws-'));
  for (const name of members) {
    const dir = path.join(root, 'atris', 'team', name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'MEMBER.md'), `---\nname: ${name}\nrole: Builder\ntype: agent\n---\n# ${name}\n`);
  }
  const teamLines = Object.entries(roster).map(([member, engine]) => `- ${member}: ${engine}`);
  if (teamLines.length) {
    fs.writeFileSync(path.join(root, 'atris', 'ROSTER.md'), `# roster\n\n## team\n${teamLines.join('\n')}\n`);
  }
  fs.mkdirSync(path.join(root, '.atris', 'state'), { recursive: true });
  fs.writeFileSync(path.join(root, '.atris', 'state', 'engines.json'), JSON.stringify({
    schema: 'atris.engine_registry.v2',
    engines: engines.map((id) => ({ id, health: { status: 'ready' } })),
  }));
  return root;
}

// A stub Swarlo hub on an ephemeral port. `failChannels` names channels
// whose post endpoint returns 500.
async function startHub({ failChannels = [], failRegister = false } = {}) {
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
      const postMatch = req.url.match(/^\/api\/([^/]+)\/channels\/([^/]+)\/posts$/);
      if (postMatch && req.method === 'POST') {
        const channel = decodeURIComponent(postMatch[2]);
        if (failChannels.includes(channel)) return send(500, { error: 'boom' });
        return send(201, { post_id: `post-${requests.length}` });
      }
      send(404, { error: 'not found' });
    });
  });
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

function modeOf(file) {
  return fs.statSync(file).mode & 0o777;
}

// ~/.swarlo is shared by every test in this file; reset it so identities,
// launched tracking, and the CLI's own state never leak between cases.
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

test('parseFleetMemberArgs reads members, value flags, equals form, and engine pairs', () => {
  const parsed = parseFleetMemberArgs([
    'builder', 'scout', '--hub', 'atris', '--server=http://x:1',
    '--channels', 'common,ops', '--engine', 'builder=claude',
    '--engine=scout=codex', '--dry-run',
  ]);
  assert.deepEqual(parsed.members, ['builder', 'scout']);
  assert.equal(parsed.hub, 'atris');
  assert.equal(parsed.server, 'http://x:1');
  assert.equal(parsed.channels, 'common,ops');
  assert.equal(parsed.dryRun, true);
  assert.equal(parsed.engines.get('builder'), 'claude');
  assert.equal(parsed.engines.get('scout'), 'codex');

  const bare = parseFleetMemberArgs(['builder', '--engine', 'grok']);
  assert.equal(bare.engineAll, 'grok');
  assert.equal(bare.engines.size, 0);
});

// ── up ───────────────────────────────────────────────────

test('fleet up registers a member, writes a 0600 identity, posts ready notes, and flips the awake switch', async () => {
  const hub = await startHub();
  const root = makeWorkspace(['builder'], { roster: { builder: 'claude' } });
  process.chdir(root);
  process.exitCode = undefined;
  try {
    const { stdout, stderr } = await capture(() => fleet(['up', 'builder', '--server', hub.url, '--hub', 'testhub', '--channels', 'common,ops']));
    assert.equal(process.exitCode, 0, stderr);
    assert.match(stdout, /builder is ready on claude in #common #ops\./);
    assert.equal(stdout.includes('key-builder'), false, 'token must never print');
    assert.equal(stderr.includes('key-builder'), false, 'token must never print');

    const identDir = path.join(fakeHome, '.swarlo', 'identities', swarlo.serverSlug(hub.url), 'testhub', 'builder');
    const file = path.join(identDir, 'config.json');
    assert.equal(modeOf(file), 0o600);
    const config = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(config.server, hub.url);
    assert.equal(config.hub, 'testhub');
    assert.equal(config.member_id, 'builder');
    assert.equal(config.token, 'key-builder');
    assert.equal(config.api_key, 'key-builder');

    const registers = hub.requests.filter((r) => r.url === '/api/register');
    assert.equal(registers.length, 1);
    assert.equal(registers[0].body.member_id, 'builder');
    assert.equal(registers[0].body.hub_id, 'testhub');
    assert.equal(registers[0].body.member_type, 'agent');

    const posts = hub.requests.filter((r) => r.url.includes('/channels/'));
    assert.equal(posts.length, 2);
    assert.ok(posts.every((p) => p.auth === 'Bearer key-builder'), 'posts authenticate as the member');
    assert.equal(posts[0].body.member_id, 'builder');
    assert.equal(posts[0].body.kind, 'status');

    const switches = JSON.parse(fs.readFileSync(path.join(root, '.atris', 'state', 'member-switches.json'), 'utf8'));
    assert.equal(switches.members.builder.awake, true);

    const launched = swarlo.loadLaunched();
    assert.equal(launched.testhub.builder.engine, 'claude');
    assert.deepEqual(launched.testhub.builder.channels, ['common', 'ops']);
  } finally {
    process.exitCode = undefined;
    hub.server.close();
  }
});

test('fleet up is idempotent: a second run reuses the stored token and skips register', async () => {
  const hub = await startHub();
  const root = makeWorkspace(['builder'], { roster: { builder: 'claude' } });
  process.chdir(root);
  process.exitCode = undefined;
  try {
    await capture(() => fleet(['up', 'builder', '--server', hub.url, '--hub', 'testhub']));
    assert.equal(process.exitCode, 0);
    const before = hub.requests.filter((r) => r.url === '/api/register').length;
    const { stdout } = await capture(() => fleet(['up', 'builder', '--server', hub.url, '--hub', 'testhub', '--json']));
    assert.equal(process.exitCode, 0);
    assert.equal(hub.requests.filter((r) => r.url === '/api/register').length, before, 'no second register');
    const payload = JSON.parse(stdout);
    assert.equal(payload.members[0].identity, 'reused');
    assert.equal(payload.members[0].stage, 'ready');
    assert.equal(JSON.stringify(payload).includes('key-builder'), false, 'json must never carry tokens');
  } finally {
    process.exitCode = undefined;
    hub.server.close();
  }
});

test('fleet up --engine overrides the roster pick and an unknown profile fails at engine stage', async () => {
  const hub = await startHub();
  const root = makeWorkspace(['builder', 'scout'], { roster: { builder: 'claude', scout: 'codex' } });
  process.chdir(root);
  process.exitCode = undefined;
  try {
    const { stdout } = await capture(() => fleet([
      'up', 'builder', 'scout', '--server', hub.url, '--hub', 'testhub',
      '--engine', 'builder=grok', '--engine', 'scout=not-an-engine',
    ]));
    assert.equal(process.exitCode, 1, 'partial: builder ready, scout failed');
    assert.match(stdout, /builder is ready on grok/);
    assert.match(stdout, /scout failed at engine: engine profile "not-an-engine" is not recognized/);
  } finally {
    process.exitCode = undefined;
    hub.server.close();
  }
});

test('fleet up fails members that are not on the team and exits 2 when none are ready', async () => {
  const hub = await startHub();
  const root = makeWorkspace(['builder'], { roster: { builder: 'claude' } });
  process.chdir(root);
  process.exitCode = undefined;
  try {
    const { stdout } = await capture(() => fleet(['up', 'ghost', '--server', hub.url, '--hub', 'testhub']));
    assert.equal(process.exitCode, 2);
    assert.match(stdout, /ghost failed at resolve: no team member named ghost/);
    assert.equal(hub.requests.filter((r) => r.url === '/api/register').length, 0);

    // One good member plus one ghost is a partial failure: exit 1.
    process.exitCode = undefined;
    const mixed = await capture(() => fleet(['up', 'builder', 'ghost', '--server', hub.url, '--hub', 'testhub']));
    assert.equal(process.exitCode, 1);
    assert.match(mixed.stdout, /builder is ready on claude/);
  } finally {
    process.exitCode = undefined;
    hub.server.close();
  }
});

test('fleet up exits 2 on preflight when the hub is unreachable', async () => {
  const root = makeWorkspace(['builder'], { roster: { builder: 'claude' } });
  process.chdir(root);
  process.exitCode = undefined;
  try {
    // Port 1 refuses connections.
    const { stdout } = await capture(() => fleet(['up', 'builder', '--server', 'http://127.0.0.1:1', '--hub', 'testhub']));
    assert.equal(process.exitCode, 2);
    assert.match(stdout, /builder failed at preflight: hub not reachable/);
  } finally {
    process.exitCode = undefined;
  }
});

test('fleet up --dry-run resolves members and engines without touching the hub', async () => {
  const hub = await startHub();
  const root = makeWorkspace(['builder'], { roster: { builder: 'claude' } });
  process.chdir(root);
  process.exitCode = undefined;
  try {
    const { stdout } = await capture(() => fleet(['up', 'builder', '--server', hub.url, '--hub', 'testhub', '--dry-run']));
    assert.equal(process.exitCode, 0);
    assert.match(stdout, /builder would be ready on claude in #common \(dry run\)/);
    assert.equal(hub.requests.length, 0, 'dry run must not call the hub');
    assert.equal(fs.existsSync(path.join(fakeHome, '.swarlo', 'identities')), false, 'dry run writes no identity');
  } finally {
    process.exitCode = undefined;
    hub.server.close();
  }
});

test('fleet up --json emits stage/engine/channels per member and never tokens', async () => {
  const hub = await startHub();
  const root = makeWorkspace(['builder'], { roster: { builder: 'claude' } });
  process.chdir(root);
  process.exitCode = undefined;
  try {
    const { stdout } = await capture(() => fleet(['up', 'builder', 'ghost', '--server', hub.url, '--hub', 'testhub', '--json']));
    assert.equal(process.exitCode, 1);
    const payload = JSON.parse(stdout);
    assert.equal(payload.hub, 'testhub');
    assert.equal(payload.server, hub.url);
    assert.equal(payload.summary.total, 2);
    assert.equal(payload.summary.ready, 1);
    const builder = payload.members.find((m) => m.member === 'builder');
    const ghost = payload.members.find((m) => m.member === 'ghost');
    assert.equal(builder.stage, 'ready');
    assert.equal(builder.engine, 'claude');
    assert.deepEqual(builder.channels, ['common']);
    assert.equal(ghost.stage, 'resolve');
    assert.ok(ghost.error);
    assert.equal(JSON.stringify(payload).includes('key-builder'), false);
  } finally {
    process.exitCode = undefined;
    hub.server.close();
  }
});

// ── launched / roster / down ─────────────────────────────

test('fleet launched and roster list activated members; fleet down posts a note and untracks', async () => {
  const hub = await startHub();
  const root = makeWorkspace(['builder'], { roster: { builder: 'claude' } });
  process.chdir(root);
  process.exitCode = undefined;
  try {
    await capture(() => fleet(['up', 'builder', '--server', hub.url, '--hub', 'testhub']));
    assert.equal(process.exitCode, 0);

    const list = await capture(() => fleet(['launched']));
    assert.match(list.stdout, /builder on testhub/);
    const alias = await capture(() => fleet(['roster', '--json']));
    const aliasPayload = JSON.parse(alias.stdout);
    assert.equal(aliasPayload.count, 1);
    assert.equal(aliasPayload.launched[0].member, 'builder');

    process.exitCode = undefined;
    const down = await capture(() => fleet(['down', 'builder', '--hub', 'testhub']));
    assert.equal(process.exitCode, 0);
    assert.match(down.stdout, /builder is down/);
    const downPosts = hub.requests.filter((r) => r.url.includes('/channels/common/posts') && r.body && r.body.content === 'builder is down');
    assert.equal(downPosts.length, 1);
    assert.equal(swarlo.loadLaunched().testhub, undefined, 'member removed from tracking');

    const after = await capture(() => fleet(['launched', '--json']));
    assert.equal(JSON.parse(after.stdout).count, 0);
  } finally {
    process.exitCode = undefined;
    hub.server.close();
  }
});

test('fleet down on a member that was never launched reports it without failing', async () => {
  const root = makeWorkspace(['builder'], { roster: { builder: 'claude' } });
  process.chdir(root);
  process.exitCode = undefined;
  try {
    const { stdout } = await capture(() => fleet(['down', 'builder']));
    assert.equal(process.exitCode, 0);
    assert.match(stdout, /builder is not launched/);
  } finally {
    process.exitCode = undefined;
  }
});
