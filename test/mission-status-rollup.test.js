const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

function makeTempDir() {
  // Worktrees land in <parent>/.agent-worktrees/<repo>/..., so give the repo a
  // parent we control and clean up in one shot.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-mission-status-rollup-test-'));
  const repo = path.join(base, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  return { base, repo };
}

function cleanupTempDir(base) {
  fs.rmSync(base, { recursive: true, force: true });
}

function runCli(args, { cwd } = {}) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 20000,
    env: {
      ...process.env,
      ATRIS_SKIP_UPDATE_CHECK: '1',
    },
  });
  if (result.error) throw result.error;
  return result;
}

function runGit(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}

function initWorkspace(repo) {
  runGit(['init'], repo);
  runGit(['config', 'user.email', 'test@example.com'], repo);
  runGit(['config', 'user.name', 'Test User'], repo);
  fs.mkdirSync(path.join(repo, 'atris'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'base.txt'), 'committed\n');
  fs.writeFileSync(path.join(repo, 'atris', '.gitkeep'), '');
  runGit(['add', '.'], repo);
  runGit(['commit', '-m', 'clean baseline'], repo);
}

function startMainMission(repo) {
  const res = runCli(['mission', 'start', '--no-verify', 'main checkout mission', '--owner', 'main-lead', '--json'], { cwd: repo });
  assert.equal(res.status, 0, res.stderr || res.stdout);
  return JSON.parse(res.stdout).mission;
}

function startWorktreeMission(repo) {
  const res = runCli(['mission', 'start', '--no-verify', 'worktree mission', '--owner', 'wt-lead', '--worktree', '--json'], { cwd: repo });
  assert.equal(res.status, 0, res.stderr || res.stdout);
  return JSON.parse(res.stdout).mission;
}

test('mission status from the main checkout rolls up sibling worktree missions', () => {
  const { base, repo } = makeTempDir();
  try {
    initWorkspace(repo);
    const mainMission = startMainMission(repo);
    const wtMission = startWorktreeMission(repo);

    const res = runCli(['mission', 'status', '--json'], { cwd: repo });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const payload = JSON.parse(res.stdout);
    const byId = new Map(payload.missions.map((mission) => [mission.id, mission]));

    assert.ok(byId.has(mainMission.id), 'local mission must stay visible');
    assert.ok(byId.has(wtMission.id), 'worktree mission must be rolled up into main status');
    assert.equal(byId.get(mainMission.id).worktree_root ?? null, null, 'local mission carries no worktree_root');
    assert.equal(
      path.resolve(byId.get(wtMission.id).worktree_root),
      path.resolve(wtMission.worktree.path),
      'rolled-up mission must point at its source worktree',
    );

    const text = runCli(['mission', 'status'], { cwd: repo });
    assert.equal(text.status, 0, text.stderr || text.stdout);
    assert.match(text.stdout, /worktree mission/, 'text status must show the rolled-up mission');
    assert.match(text.stdout, /worktree:/, 'text status must show where the rolled-up mission lives');
  } finally {
    cleanupTempDir(base);
  }
});

test('mission status from inside a worktree rolls up main checkout missions', () => {
  const { base, repo } = makeTempDir();
  try {
    initWorkspace(repo);
    const mainMission = startMainMission(repo);
    const wtMission = startWorktreeMission(repo);

    const res = runCli(['mission', 'status', '--json'], { cwd: wtMission.worktree.path });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const byId = new Map(JSON.parse(res.stdout).missions.map((mission) => [mission.id, mission]));
    assert.ok(byId.has(wtMission.id), 'worktree-local mission must stay visible');
    assert.ok(byId.has(mainMission.id), 'main checkout mission must roll up into worktree status');
  } finally {
    cleanupTempDir(base);
  }
});

test('mission status --local keeps the current-checkout-only view', () => {
  const { base, repo } = makeTempDir();
  try {
    initWorkspace(repo);
    const mainMission = startMainMission(repo);
    const wtMission = startWorktreeMission(repo);

    const res = runCli(['mission', 'status', '--local', '--json'], { cwd: repo });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const ids = JSON.parse(res.stdout).missions.map((mission) => mission.id);
    assert.ok(ids.includes(mainMission.id));
    assert.ok(!ids.includes(wtMission.id), '--local must not roll up worktree missions');
  } finally {
    cleanupTempDir(base);
  }
});

test('mission status --status filter applies across rolled-up missions', () => {
  const { base, repo } = makeTempDir();
  try {
    initWorkspace(repo);
    startMainMission(repo);
    const wtMission = startWorktreeMission(repo);

    const res = runCli(['mission', 'status', '--status', 'active', '--json'], { cwd: repo });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const ids = JSON.parse(res.stdout).missions.map((mission) => mission.id);
    assert.ok(ids.includes(wtMission.id), 'active filter must include rolled-up active missions');
  } finally {
    cleanupTempDir(base);
  }
});

test('mission status outside a git repo still works without rollup', () => {
  const { base, repo } = makeTempDir();
  try {
    // No git init: rollup has nothing to enumerate and must not crash.
    const res = runCli(['mission', 'status', '--json'], { cwd: repo });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.deepEqual(JSON.parse(res.stdout).missions, []);
  } finally {
    cleanupTempDir(base);
  }
});
