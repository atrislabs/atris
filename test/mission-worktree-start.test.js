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
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-mission-worktree-start-test-'));
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

test('mission start --worktree creates an isolated checkout holding the mission state', () => {
  const { base, repo } = makeTempDir();
  try {
    initWorkspace(repo);
    // Dirty the main checkout: this noise must never reach the mission baseline.
    fs.writeFileSync(path.join(repo, 'main-dirt.txt'), 'noise\n');

    const res = runCli(['mission', 'start', 'isolated mission', '--owner', 'mission-lead', '--worktree', '--json'], { cwd: repo });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const payload = JSON.parse(res.stdout);
    const mission = payload.mission;

    assert.equal(mission.objective, 'isolated mission', 'flag must not leak into the objective');
    assert.ok(mission.worktree, 'mission must record its worktree');
    const wtPath = mission.worktree.path;
    assert.ok(fs.existsSync(wtPath), `worktree must exist at ${wtPath}`);
    assert.notEqual(path.resolve(wtPath), path.resolve(repo));
    assert.ok(mission.worktree.branch, 'mission must record its branch');

    // Mission state lives inside the worktree, not the main checkout.
    assert.ok(fs.existsSync(path.join(wtPath, '.atris', 'state', 'missions.jsonl')));
    assert.ok(!fs.existsSync(path.join(repo, '.atris', 'state', 'missions.jsonl')));

    // Baseline sidecar lives inside the worktree and excludes main-checkout dirt.
    const sidecar = path.join(wtPath, '.atris', 'state', 'mission-baselines', `${mission.id}.json`);
    assert.ok(fs.existsSync(sidecar));
    const baseline = JSON.parse(fs.readFileSync(sidecar, 'utf8'));
    assert.ok(!baseline.paths.includes('main-dirt.txt'),
      'main checkout dirt must not appear in the worktree baseline');
  } finally {
    cleanupTempDir(base);
  }
});

test('ticks inside the mission worktree run against a clean mission_start baseline', () => {
  const { base, repo } = makeTempDir();
  try {
    initWorkspace(repo);
    const started = runCli(['mission', 'start', 'tickable isolated mission', '--owner', 'mission-lead', '--worktree', '--json'], { cwd: repo });
    assert.equal(started.status, 0, started.stderr || started.stdout);
    const mission = JSON.parse(started.stdout).mission;
    const wtPath = mission.worktree.path;

    const cleanTick = runCli(['mission', 'tick', mission.id, '--json'], { cwd: wtPath });
    assert.equal(cleanTick.status, 0, cleanTick.stderr || cleanTick.stdout);
    const cleanWorktree = JSON.parse(cleanTick.stdout).tick.worktree;
    assert.equal(cleanWorktree.baseline_source, 'mission_start');
    assert.equal(cleanWorktree.new_since_baseline_count, 0);
    assert.equal(cleanWorktree.unverified_dirty, false);

    // Real work inside the worktree is attributed to the mission.
    fs.writeFileSync(path.join(wtPath, 'mission-work.txt'), 'real change\n');
    const dirtyTick = runCli(['mission', 'tick', mission.id, '--json'], { cwd: wtPath });
    assert.equal(dirtyTick.status, 0, dirtyTick.stderr || dirtyTick.stdout);
    const dirtyWorktree = JSON.parse(dirtyTick.stdout).tick.worktree;
    assert.equal(dirtyWorktree.new_since_baseline_count, 1);
    assert.ok(dirtyWorktree.new_since_baseline_sample.includes('mission-work.txt'));
  } finally {
    cleanupTempDir(base);
  }
});

test('mission start --worktree outside a git repo fails with a clear error', () => {
  const { base, repo } = makeTempDir();
  try {
    // No git init: worktree creation has nothing to attach to.
    fs.mkdirSync(path.join(repo, 'atris'), { recursive: true });
    const res = runCli(['mission', 'start', 'no repo mission', '--owner', 'mission-lead', '--worktree', '--json'], { cwd: repo });
    assert.notEqual(res.status, 0, 'must fail outside a git repo');
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.ok, false);
    assert.match(payload.error, /worktree/i);
  } finally {
    cleanupTempDir(base);
  }
});

test('mission start without --worktree keeps the current-directory behavior', () => {
  const { base, repo } = makeTempDir();
  try {
    initWorkspace(repo);
    const res = runCli(['mission', 'start', 'plain mission', '--owner', 'mission-lead', '--json'], { cwd: repo });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const mission = JSON.parse(res.stdout).mission;
    assert.equal(mission.worktree ?? null, null);
    assert.ok(fs.existsSync(path.join(repo, '.atris', 'state', 'missions.jsonl')));
  } finally {
    cleanupTempDir(base);
  }
});
