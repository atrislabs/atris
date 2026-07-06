const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-mission-baseline-test-'));
}

function cleanupTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
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

function initGitRepo(dir) {
  runGit(['init'], dir);
  runGit(['config', 'user.email', 'test@example.com'], dir);
  runGit(['config', 'user.name', 'Test User'], dir);
}

function commitAll(dir, message) {
  runGit(['add', '.'], dir);
  runGit(['commit', '-m', message], dir);
}

function startMission(dir, title, extraArgs = []) {
  const res = runCli(['mission', 'start', '--no-verify', title, '--owner', 'mission-lead', '--json', ...extraArgs], { cwd: dir });
  assert.equal(res.status, 0, res.stderr || res.stdout);
  return JSON.parse(res.stdout).mission;
}

function tickMission(dir, missionId) {
  const res = runCli(['mission', 'tick', missionId, '--json'], { cwd: dir });
  assert.equal(res.status, 0, res.stderr || res.stdout);
  return JSON.parse(res.stdout);
}

function baselineSidecarPath(dir, missionId) {
  return path.join(dir, '.atris', 'state', 'mission-baselines', `${missionId}.json`);
}

test('mission tick does not flag pre-existing workspace dirt as unverified', () => {
  const dir = makeTempDir();
  try {
    initGitRepo(dir);
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'base.txt'), 'committed\n');
    commitAll(dir, 'clean baseline');

    // Pre-existing dirt: present before the mission starts, not caused by it.
    fs.writeFileSync(path.join(dir, 'preexisting-a.txt'), 'noise\n');
    fs.writeFileSync(path.join(dir, 'preexisting-b.txt'), 'noise\n');

    const mission = startMission(dir, 'baseline subtraction mission');
    const sidecar = baselineSidecarPath(dir, mission.id);
    assert.ok(fs.existsSync(sidecar), `expected baseline sidecar at ${sidecar}`);
    const baseline = JSON.parse(fs.readFileSync(sidecar, 'utf8'));
    assert.equal(baseline.mission_id, mission.id);
    assert.ok(baseline.paths.includes('preexisting-a.txt'));
    assert.ok(baseline.paths.includes('preexisting-b.txt'));

    // No-op tick: nothing touched since mission start.
    const payload = tickMission(dir, mission.id);
    const worktree = payload.tick.worktree;
    assert.equal(worktree.available, true);
    assert.equal(worktree.baseline_source, 'mission_start');
    assert.ok(worktree.baseline_dirty_count >= 2);
    assert.equal(worktree.new_since_baseline_count, 0);
    assert.deepEqual(worktree.new_since_baseline_sample, []);
    assert.equal(worktree.unverified_dirty, false,
      'pre-existing dirt must not flag unverified_dirty');
  } finally {
    cleanupTempDir(dir);
  }
});

test('mission tick still flags dirt created after mission start', () => {
  const dir = makeTempDir();
  try {
    initGitRepo(dir);
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'base.txt'), 'committed\n');
    commitAll(dir, 'clean baseline');
    fs.writeFileSync(path.join(dir, 'preexisting-a.txt'), 'noise\n');

    const mission = startMission(dir, 'mission-caused dirt mission');

    // Mission-caused dirt: created after the baseline snapshot.
    fs.writeFileSync(path.join(dir, 'mission-work.txt'), 'real change\n');

    const payload = tickMission(dir, mission.id);
    const worktree = payload.tick.worktree;
    assert.equal(worktree.baseline_source, 'mission_start');
    assert.equal(worktree.unverified_dirty, true);
    assert.equal(worktree.new_since_baseline_count, 1);
    assert.ok(worktree.new_since_baseline_sample.includes('mission-work.txt'));
    assert.ok(!worktree.new_since_baseline_sample.includes('preexisting-a.txt'),
      'pre-existing dirt must stay out of the new-since-baseline sample');
  } finally {
    cleanupTempDir(dir);
  }
});

test('missions without a baseline sidecar fall back to tick-start baseline', () => {
  const dir = makeTempDir();
  try {
    initGitRepo(dir);
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'base.txt'), 'committed\n');
    commitAll(dir, 'clean baseline');

    const mission = startMission(dir, 'legacy mission without sidecar');
    fs.rmSync(baselineSidecarPath(dir, mission.id), { force: true });

    // Dirt exists before the tick command runs; with tick-start fallback it is
    // treated as pre-existing rather than unverified mission dirt.
    fs.writeFileSync(path.join(dir, 'pre-tick.txt'), 'noise\n');

    const payload = tickMission(dir, mission.id);
    const worktree = payload.tick.worktree;
    assert.equal(worktree.available, true);
    assert.equal(worktree.baseline_source, 'tick_start');
    assert.equal(worktree.new_since_baseline_count, 0);
    assert.equal(worktree.unverified_dirty, false);
  } finally {
    cleanupTempDir(dir);
  }
});
