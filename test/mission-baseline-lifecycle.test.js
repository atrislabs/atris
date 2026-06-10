const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

const PASSING_VERIFIER = `${process.execPath} -e "process.exit(0)"`;

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-mission-baseline-lifecycle-test-'));
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

function initWorkspace(dir) {
  runGit(['init'], dir);
  runGit(['config', 'user.email', 'test@example.com'], dir);
  runGit(['config', 'user.name', 'Test User'], dir);
  fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'base.txt'), 'committed\n');
  runGit(['add', '.'], dir);
  runGit(['commit', '-m', 'clean baseline'], dir);
}

function startMission(dir, title, extraArgs = []) {
  const res = runCli(['mission', 'start', title, '--owner', 'mission-lead', '--json', ...extraArgs], { cwd: dir });
  assert.equal(res.status, 0, res.stderr || res.stdout);
  return JSON.parse(res.stdout).mission;
}

function tickMission(dir, missionId, extraArgs = []) {
  const res = runCli(['mission', 'tick', missionId, '--json', ...extraArgs], { cwd: dir });
  assert.equal(res.status, 0, res.stderr || res.stdout);
  return JSON.parse(res.stdout);
}

function baselineSidecarPath(dir, missionId) {
  return path.join(dir, '.atris', 'state', 'mission-baselines', `${missionId}.json`);
}

test('mission complete prunes the baseline sidecar and folds a summary into the record', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    // Pre-existing dirt so the baseline has real content to summarize.
    fs.writeFileSync(path.join(dir, 'preexisting.txt'), 'noise\n');

    const mission = startMission(dir, 'lifecycle complete mission', ['--verify', PASSING_VERIFIER]);
    const sidecar = baselineSidecarPath(dir, mission.id);
    assert.ok(fs.existsSync(sidecar));
    const baseline = JSON.parse(fs.readFileSync(sidecar, 'utf8'));

    const tick = tickMission(dir, mission.id, ['--verify']);
    assert.equal(tick.verifier_result.passed, true);

    const res = runCli(['mission', 'complete', mission.id, '--proof', tick.receipt_path, '--json'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.mission.status, 'complete');

    assert.ok(!fs.existsSync(sidecar), 'sidecar must be pruned after complete');
    const summary = payload.mission.worktree_baseline;
    assert.ok(summary, 'completed mission must keep a baseline audit summary');
    assert.equal(summary.captured_at, baseline.captured_at);
    assert.equal(summary.dirty_count, baseline.dirty_count);
    assert.equal(summary.dirty_hash, baseline.dirty_hash);
    assert.equal(summary.path_count, baseline.paths.length);
  } finally {
    cleanupTempDir(dir);
  }
});

test('mission stop prunes the baseline sidecar', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    const mission = startMission(dir, 'lifecycle stop mission');
    const sidecar = baselineSidecarPath(dir, mission.id);
    assert.ok(fs.existsSync(sidecar));

    const res = runCli(['mission', 'stop', mission.id, '--reason', 'test stop', '--json'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.mission.status, 'stopped');
    assert.ok(!fs.existsSync(sidecar), 'sidecar must be pruned after stop');
    assert.ok(payload.mission.worktree_baseline, 'stopped mission keeps a baseline audit summary');
  } finally {
    cleanupTempDir(dir);
  }
});

test('mission pause preserves the baseline sidecar so resume ticks still subtract it', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    fs.writeFileSync(path.join(dir, 'preexisting.txt'), 'noise\n');

    const mission = startMission(dir, 'lifecycle pause mission');
    const sidecar = baselineSidecarPath(dir, mission.id);
    assert.ok(fs.existsSync(sidecar));

    const res = runCli(['mission', 'stop', mission.id, '--pause', '--json'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.equal(JSON.parse(res.stdout).mission.status, 'paused');
    assert.ok(fs.existsSync(sidecar), 'paused mission must keep its sidecar');

    // Resume tick still baselines against mission start, not tick start.
    const tick = tickMission(dir, mission.id);
    assert.equal(tick.tick.worktree.baseline_source, 'mission_start');
    assert.equal(tick.tick.worktree.unverified_dirty, false);
  } finally {
    cleanupTempDir(dir);
  }
});

test('closing a mission without a sidecar stays clean', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    const mission = startMission(dir, 'legacy mission without sidecar');
    fs.rmSync(baselineSidecarPath(dir, mission.id), { force: true });

    const res = runCli(['mission', 'stop', mission.id, '--json'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.mission.status, 'stopped');
    assert.equal(payload.mission.worktree_baseline ?? null, null);
  } finally {
    cleanupTempDir(dir);
  }
});
