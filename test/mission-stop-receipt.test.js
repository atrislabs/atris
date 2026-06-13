const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

const FAILING_VERIFIER = `${process.execPath} -e "process.exit(1)"`;
const PASSING_VERIFIER = `${process.execPath} -e "process.exit(0)"`;

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-mission-stop-receipt-test-'));
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

test('mission stop writes a stop receipt with worktree-vs-baseline evidence', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    // Pre-existing dirt lands in the baseline.
    fs.writeFileSync(path.join(dir, 'preexisting.txt'), 'noise\n');
    const mission = startMission(dir, 'abandoned mission');
    // Mission-caused dirt: what the stop receipt must expose for triage.
    fs.writeFileSync(path.join(dir, 'leftover-work.txt'), 'half done\n');

    const res = runCli(['mission', 'stop', mission.id, '--reason', 'priorities changed', '--json'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.mission.status, 'stopped');
    assert.ok(payload.receipt_path, 'stop must report a receipt path');
    assert.equal(payload.mission.receipt_path, payload.receipt_path);

    const receipt = JSON.parse(fs.readFileSync(path.join(dir, payload.receipt_path), 'utf8'));
    assert.equal(receipt.mission_id, mission.id);
    assert.equal(receipt.result.kind, 'mission_stop');
    assert.equal(receipt.result.reason, 'priorities changed');
    const worktree = receipt.result.worktree;
    assert.equal(worktree.available, true);
    assert.equal(worktree.baseline_source, 'mission_start');
    assert.equal(worktree.new_since_baseline_count, 1);
    assert.ok(worktree.new_since_baseline_sample.includes('leftover-work.txt'));
    assert.ok(!worktree.new_since_baseline_sample.includes('preexisting.txt'));
  } finally {
    cleanupTempDir(dir);
  }
});

test('mission pause does not write a stop receipt', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    const mission = startMission(dir, 'paused mission');

    const res = runCli(['mission', 'stop', mission.id, '--pause', '--json'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.mission.status, 'paused');
    assert.equal(payload.receipt_path ?? null, null, 'pause must not write a stop receipt');
  } finally {
    cleanupTempDir(dir);
  }
});

test('mission tick clears stale pause metadata after verifier passes', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    const mission = startMission(dir, 'pause recovery mission', ['--verify', PASSING_VERIFIER]);

    const paused = runCli(['mission', 'stop', mission.id, '--pause', '--reason', 'rate-limit-exceeded-wall', '--json'], { cwd: dir });
    assert.equal(paused.status, 0, paused.stderr || paused.stdout);
    const pausedPayload = JSON.parse(paused.stdout);
    assert.equal(pausedPayload.mission.status, 'paused');
    assert.equal(pausedPayload.mission.stop_reason, 'rate-limit-exceeded-wall');
    assert.ok(pausedPayload.mission.paused_at);

    const tick = tickMission(dir, mission.id, ['--verify']);
    assert.equal(tick.mission.status, 'ready');
    assert.equal(tick.mission.stop_reason, null);
    assert.equal(tick.mission.paused_at, null);
    assert.ok(tick.mission.resumed_at, 'manual recovery tick should record a resumed timestamp');
  } finally {
    cleanupTempDir(dir);
  }
});

test('mission status surfaces the completion gate for completed missions', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    const mission = startMission(dir, 'gated completion mission', ['--verify', PASSING_VERIFIER]);
    const tick = tickMission(dir, mission.id, ['--verify']);
    const completed = runCli(['mission', 'complete', mission.id, '--proof', tick.receipt_path, '--json'], { cwd: dir });
    assert.equal(completed.status, 0, completed.stderr || completed.stdout);

    const status = runCli(['mission', 'status', '--json'], { cwd: dir });
    assert.equal(status.status, 0, status.stderr || status.stdout);
    const payload = JSON.parse(status.stdout);
    const saved = payload.missions.find((entry) => entry.id === mission.id);
    assert.equal(saved.completion_gate.source, 'receipt');

    const nowMd = fs.readFileSync(path.join(dir, 'atris', 'status', 'now.md'), 'utf8');
    assert.match(nowMd, /gate: receipt/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('forced completions are visibly marked in mission status', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    const mission = startMission(dir, 'forced completion mission', ['--verify', FAILING_VERIFIER]);
    const completed = runCli(['mission', 'complete', mission.id, '--proof', 'operator override', '--force', '--json'], { cwd: dir });
    assert.equal(completed.status, 0, completed.stderr || completed.stdout);

    const status = runCli(['mission', 'status', '--json'], { cwd: dir });
    assert.equal(status.status, 0, status.stderr || status.stdout);

    const nowMd = fs.readFileSync(path.join(dir, 'atris', 'status', 'now.md'), 'utf8');
    assert.match(nowMd, /gate: forced override/);
  } finally {
    cleanupTempDir(dir);
  }
});
