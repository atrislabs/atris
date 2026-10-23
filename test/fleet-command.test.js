const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');

// fleet.js resolves its Swarlo state file from os.homedir() when it loads,
// so HOME must point at a scratch dir before the require below.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-fleet-command-'));
const fakeHome = path.join(sandbox, 'home');
fs.mkdirSync(fakeHome, { recursive: true });

const realEnv = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
const realCwd = process.cwd();
const realExitCode = process.exitCode;
process.env.HOME = fakeHome;
process.env.USERPROFILE = fakeHome;

const { fleet, fleetWorkspaceStatus } = require('../commands/fleet');

let workspaceCount = 0;

function makeWorkspace({ members = [], missions = null, extraTeamEntries = {} } = {}) {
  workspaceCount += 1;
  const root = path.join(sandbox, `ws-${workspaceCount}`);
  fs.mkdirSync(root, { recursive: true });
  for (const name of members) {
    const dir = path.join(root, 'atris', 'team', name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'MEMBER.md'), `# ${name}\n`);
  }
  for (const [name, withMemberFile] of Object.entries(extraTeamEntries)) {
    const dir = path.join(root, 'atris', 'team', name);
    fs.mkdirSync(dir, { recursive: true });
    if (withMemberFile) fs.writeFileSync(path.join(dir, 'MEMBER.md'), `# ${name}\n`);
  }
  if (missions !== null) {
    const stateDir = path.join(root, '.atris', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'missions.jsonl'), missions);
  }
  return root;
}

// Runs fn with console output captured. Any attempt to open a network
// connection or exit the process is recorded and turned into a thrown error.
async function capture(fn) {
  const out = [];
  const err = [];
  const networkCalls = [];
  const orig = {
    log: console.log,
    error: console.error,
    httpRequest: http.request,
    httpsRequest: https.request,
    exit: process.exit,
  };
  console.log = (...a) => out.push(a.join(' '));
  console.error = (...a) => err.push(a.join(' '));
  http.request = (...a) => { networkCalls.push(a); throw new Error('network call blocked in test'); };
  https.request = (...a) => { networkCalls.push(a); throw new Error('network call blocked in test'); };
  process.exit = (code) => { throw new Error(`process.exit(${code}) called`); };
  try {
    await fn();
  } finally {
    console.log = orig.log;
    console.error = orig.error;
    http.request = orig.httpRequest;
    https.request = orig.httpsRequest;
    process.exit = orig.exit;
  }
  return { stdout: out.join('\n'), stderr: err.join('\n'), networkCalls };
}

test.after(() => {
  process.chdir(realCwd);
  process.exitCode = realExitCode;
  for (const [key, value] of Object.entries(realEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(sandbox, { recursive: true, force: true });
});

test('exports fleet and fleetWorkspaceStatus as functions', () => {
  assert.strictEqual(typeof fleet, 'function');
  assert.strictEqual(typeof fleetWorkspaceStatus, 'function');
});

test('help prints every subcommand and returns without touching the hub', async () => {
  const { stdout, stderr, networkCalls } = await capture(() => fleet(['help']));
  assert.match(stdout, /atris fleet: coordinate agent swarm via Swarlo/);
  for (const line of ['fleet --global', 'fleet post <msg>', 'fleet task <prompt>', 'fleet claim <key>', 'fleet done <key>', 'fleet members', 'fleet prune [min]', 'fleet watch [sec]']) {
    assert.ok(stdout.includes(line), `help should mention "${line}"`);
  }
  assert.strictEqual(stderr, '');
  assert.deepStrictEqual(networkCalls, []);

  // Subcommands are case-insensitive and --global does not defeat help.
  const upper = await capture(() => fleet(['HELP', '--global']));
  assert.strictEqual(upper.stdout, stdout);
  assert.deepStrictEqual(upper.networkCalls, []);
});

test('fleetWorkspaceStatus json lists only real members and counts active missions', async () => {
  const missions = [
    JSON.stringify({ id: 'm1', status: 'running' }),
    JSON.stringify({ id: 'm2', status: 'ready' }),
    JSON.stringify({ id: 'm3', status: 'done' }),
    JSON.stringify({ id: 'm1', status: 'done' }), // later record closes m1
    JSON.stringify({ mission_id: 'm4', status: 'paused' }),
    JSON.stringify({ id: 'm5', status: 'planning' }),
    JSON.stringify({ id: 'm3', status: 'running' }), // later record reopens m3
    JSON.stringify({ status: 'running' }), // no id, ignored
    '',
    'not json at all',
    JSON.stringify({ id: 'm6', status: 'failed' }),
  ].join('\n');
  const root = makeWorkspace({
    members: ['scout', 'builder'],
    extraTeamEntries: { _template: true, '.hidden': true, 'no-member-file': false },
    missions,
  });
  fs.writeFileSync(path.join(root, 'atris', 'team', 'README.md'), 'not a member\n');

  const { stdout, stderr, networkCalls } = await capture(() => fleetWorkspaceStatus(root, { json: true }));
  const payload = JSON.parse(stdout);

  assert.strictEqual(payload.scope, 'workspace');
  assert.strictEqual(payload.hub, null);
  assert.strictEqual(payload.members.count, 2);
  assert.deepStrictEqual(
    payload.members.members.map((m) => m.member_id).sort(),
    ['builder', 'scout'],
  );
  for (const m of payload.members.members) {
    assert.strictEqual(m.member_name, m.member_id);
    assert.strictEqual(m.member_type, 'agent');
    assert.strictEqual(m.source, 'workspace');
  }
  assert.deepStrictEqual(payload.claims, { count: 0, claims: [] });
  // m2 ready, m3 reopened, m4 paused, m5 planning. m1 closed, m6 failed, id-less row skipped.
  assert.strictEqual(payload.missions_active, 4);
  assert.match(payload.note, /--global/);
  assert.strictEqual(stderr, '');
  assert.deepStrictEqual(networkCalls, []);
});

test('fleetWorkspaceStatus on an empty workspace reports zero members and zero missions', async () => {
  const root = makeWorkspace();
  const { stdout } = await capture(() => fleetWorkspaceStatus(root, { json: true }));
  const payload = JSON.parse(stdout);
  assert.strictEqual(payload.members.count, 0);
  assert.deepStrictEqual(payload.members.members, []);
  assert.strictEqual(payload.missions_active, 0);

  const text = await capture(() => fleetWorkspaceStatus(root));
  assert.match(text.stdout, /Fleet \(workspace\)/);
  assert.match(text.stdout, /Members: 0 \(from atris\/team\)/);
  assert.match(text.stdout, /Missions active: 0/);
  assert.match(text.stdout, /Hub: {5}not queried \(use --global for localhost Swarlo\)/);
});

test('fleetWorkspaceStatus text view names members and caps the list at 24 while counting all', async () => {
  const names = Array.from({ length: 30 }, (_, i) => `member-${String(i).padStart(2, '0')}`);
  const root = makeWorkspace({ members: names });
  const { stdout } = await capture(() => fleetWorkspaceStatus(root));

  assert.match(stdout, /Members: 30 \(from atris\/team\)/);
  const listed = stdout.split('\n').filter((line) => /^ {4}member-\d\d$/.test(line));
  assert.strictEqual(listed.length, 24);
  assert.ok(listed.every((line) => names.includes(line.trim())));
});

test('fleet defaults to workspace status for the current directory, with and without --json', async () => {
  const root = makeWorkspace({
    members: ['alpha'],
    missions: `${JSON.stringify({ id: 'x', status: 'running' })}\n`,
  });
  process.chdir(root);

  const bare = await capture(() => fleet([]));
  assert.match(bare.stdout, /Scope: {3}workspace/);
  assert.match(bare.stdout, /Members: 1 \(from atris\/team\)/);
  assert.match(bare.stdout, /Missions active: 1/);
  assert.deepStrictEqual(bare.networkCalls, []);

  for (const args of [['status', '--json'], ['--json'], ['who', '--json'], ['members', '--json'], ['st', '--json']]) {
    const res = await capture(() => fleet(args));
    const payload = JSON.parse(res.stdout);
    assert.strictEqual(payload.scope, 'workspace', `fleet ${args.join(' ')}`);
    assert.deepStrictEqual(payload.members.members.map((m) => m.member_id), ['alpha'], `fleet ${args.join(' ')}`);
    assert.strictEqual(payload.missions_active, 1, `fleet ${args.join(' ')}`);
    assert.deepStrictEqual(res.networkCalls, [], `fleet ${args.join(' ')}`);
  }
});

test('hub mutations without --global are refused with exit code 1 and no network traffic', async () => {
  const root = makeWorkspace({ members: ['alpha'] });
  process.chdir(root);

  const mutations = ['post', 'say', 'task', 'claim', 'done', 'report', 'prune', 'watch', 'tail'];
  for (const sub of mutations) {
    process.exitCode = undefined;
    const res = await capture(() => fleet([sub, 'something']));
    assert.strictEqual(process.exitCode, 1, `fleet ${sub} should set exit code 1`);
    assert.match(res.stderr, /fleet mutations need the machine hub\. re-run with --global\./, `fleet ${sub}`);
    assert.strictEqual(res.stdout, '', `fleet ${sub} should print nothing to stdout`);
    assert.deepStrictEqual(res.networkCalls, [], `fleet ${sub} should not contact the hub`);
  }
  process.exitCode = undefined;

  // The refusal must not have created the Swarlo state dir under the fake HOME.
  assert.deepStrictEqual(fs.readdirSync(fakeHome), []);
});
