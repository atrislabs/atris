const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

// BCK-1319: `mission list` and `mission run/tick/show` used to disagree on
// which mission a given n/id/slug pointed at, and a mistyped or stale id
// fragment would silently start a brand-new mission instead of erroring.
// These tests seed a small mixed-status board and assert list and resolver
// agree on every handle, and that unresolvable handles fail loudly.

function makeRepo() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-resolver-'));
  const repo = path.join(base, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  spawnSync('git', ['init', '-q', '-b', 'master'], { cwd: repo });
  spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: repo });
  spawnSync('git', ['config', 'user.name', 'test'], { cwd: repo });
  return { base, repo };
}

function runCli(args, cwd) {
  const env = { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1' };
  delete env.ATRIS_RUNNER_PROFILE;
  return spawnSync(process.execPath, [cliPath, ...args], { cwd, encoding: 'utf8', env, timeout: 20000 });
}

function startMission(repo, objective, owner) {
  const res = runCli(['mission', 'start', '--no-verify', objective, '--owner', owner, '--json'], repo);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  return JSON.parse(res.stdout).mission;
}

function listMissions(repo) {
  const res = runCli(['mission', 'list', '--json'], repo);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  return JSON.parse(res.stdout).missions;
}

test('list n, full id, and unique id suffix all resolve to the same mission run/tick/show sees', () => {
  const { base, repo } = makeRepo();
  try {
    const alpha = startMission(repo, 'alpha objective one', 'alice');
    const beta = startMission(repo, 'beta objective two', 'bob');
    const gamma = startMission(repo, 'gamma objective three', 'carol');

    // Mixed statuses: alpha stays planning, beta gets stopped, gamma gets ticked to running.
    assert.equal(runCli(['mission', 'stop', beta.id, '--reason', 'test'], repo).status, 0);
    assert.equal(
      runCli(['mission', 'run', gamma.id, '--no-claude', '--max-ticks', '1', '--json'], repo).status,
      0,
    );

    const listed = listMissions(repo);
    assert.equal(listed.length, 3);

    for (const row of listed) {
      assert.ok(row.n, `mission ${row.id} must have a display n`);

      // n resolves to the same mission list showed at that n.
      const byNumber = runCli(['mission', 'show', String(row.n), '--json'], repo);
      assert.equal(byNumber.status, 0, byNumber.stderr || byNumber.stdout);
      const byNumberMission = JSON.parse(byNumber.stdout).missions[0];
      assert.equal(byNumberMission.id, row.id, `n=${row.n} must resolve to ${row.id}, not ${byNumberMission.id}`);

      // full id resolves to itself.
      const byId = runCli(['mission', 'show', row.id, '--json'], repo);
      assert.equal(byId.status, 0, byId.stderr || byId.stdout);
      assert.equal(JSON.parse(byId.stdout).missions[0].id, row.id);

      // unique suffix (>=6 chars) resolves to itself.
      const suffix = row.id.slice(-8);
      const bySuffix = runCli(['mission', 'show', suffix, '--json'], repo);
      assert.equal(bySuffix.status, 0, bySuffix.stderr || bySuffix.stdout);
      assert.equal(JSON.parse(bySuffix.stdout).missions[0].id, row.id);

      // slug resolves to itself.
      const bySlug = runCli(['mission', 'show', row.slug, '--json'], repo);
      assert.equal(bySlug.status, 0, bySlug.stderr || bySlug.stdout);
      assert.equal(JSON.parse(bySlug.stdout).missions[0].id, row.id);
    }
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('mission run with the full id copied from list --json resolves and runs it, never 404s', () => {
  const { base, repo } = makeRepo();
  try {
    const mission = startMission(repo, 'ship the resolver fix', 'alice');
    const listed = listMissions(repo);
    const row = listed.find((m) => m.id === mission.id);
    assert.ok(row, 'mission must appear in list output');

    const run = runCli(['mission', 'run', row.id, '--no-claude', '--max-ticks', '1', '--json'], repo);
    assert.equal(run.status, 0, run.stderr || run.stdout);
    const payload = JSON.parse(run.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.mission.id, mission.id);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('an unmatched hex-looking ref errors instead of silently starting a new mission', () => {
  const { base, repo } = makeRepo();
  try {
    startMission(repo, 'keep this mission alone', 'alice');
    const before = listMissions(repo);
    assert.equal(before.length, 1);

    const run = runCli(['mission', 'run', 'deadbeefaa', '--no-claude', '--json'], repo);
    assert.notEqual(run.status, 0, 'a bogus id-shaped ref must not exit 0');
    const payload = JSON.parse(run.stdout);
    assert.equal(payload.ok, false);
    assert.match(payload.error, /not found/i);

    const after = listMissions(repo);
    assert.equal(after.length, 1, 'no junk mission must be created from the bogus ref');
    assert.deepEqual(after.map((m) => m.id).sort(), before.map((m) => m.id).sort());
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('an unmatched bare number errors instead of silently starting a new mission', () => {
  const { base, repo } = makeRepo();
  try {
    startMission(repo, 'keep this mission alone too', 'alice');
    const before = listMissions(repo);

    const run = runCli(['mission', 'run', '99', '--no-claude', '--json'], repo);
    assert.notEqual(run.status, 0);
    const payload = JSON.parse(run.stdout);
    assert.equal(payload.ok, false);

    const after = listMissions(repo);
    assert.equal(after.length, before.length, 'no junk mission from an out-of-range n');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('a genuine multi-word objective still starts a new mission (unchanged behavior)', () => {
  const { base, repo } = makeRepo();
  try {
    const before = listMissions(repo);
    assert.equal(before.length, 0);

    const run = runCli(['mission', 'run', 'fix the flaky login test', '--owner', 'alice', '--no-claude', '--json'], repo);
    assert.equal(run.status, 0, run.stderr || run.stdout);
    const payload = JSON.parse(run.stdout);
    assert.equal(payload.ok, true);

    const after = listMissions(repo);
    assert.equal(after.length, 1, 'a real objective (whitespace, non-handle-shaped) must still create a mission');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
