const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

const PASSING_VERIFIER = `${process.execPath} -e "process.exit(0)"`;
const FAILING_VERIFIER = `${process.execPath} -e "process.exit(1)"`;

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-mission-complete-guard-test-'));
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
  const res = runCli(['mission', 'start', '--no-verify', title, '--owner', 'mission-lead', '--json', ...extraArgs], { cwd: dir });
  assert.equal(res.status, 0, res.stderr || res.stdout);
  return JSON.parse(res.stdout).mission;
}

function tickMission(dir, missionId, extraArgs = []) {
  const res = runCli(['mission', 'tick', missionId, '--json', ...extraArgs], { cwd: dir });
  assert.equal(res.status, 0, res.stderr || res.stdout);
  return JSON.parse(res.stdout);
}

function completeMission(dir, missionId, proof, extraArgs = []) {
  return runCli(['mission', 'complete', missionId, '--proof', proof, '--json', ...extraArgs], { cwd: dir });
}

function missionById(dir, missionId) {
  const res = runCli(['mission', 'status', '--json'], { cwd: dir });
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const payload = JSON.parse(res.stdout);
  return (payload.missions || []).find((mission) => mission.id === missionId) || null;
}

test('free-text proof on a verifier mission is rejected until the verifier passes', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    const mission = startMission(dir, 'guarded mission', ['--verify', PASSING_VERIFIER]);

    const res = completeMission(dir, mission.id, 'trust me, it works');
    assert.notEqual(res.status, 0, 'completion must fail without verifier evidence');
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.ok, false);
    assert.match(payload.error, /verifier/i);

    const saved = missionById(dir, mission.id);
    assert.notEqual(saved.status, 'complete', 'mission must stay open after rejected completion');
  } finally {
    cleanupTempDir(dir);
  }
});

test('a passing tick receipt is accepted as completion proof', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    const mission = startMission(dir, 'provable mission', ['--verify', PASSING_VERIFIER]);
    const tick = tickMission(dir, mission.id, ['--verify']);
    assert.equal(tick.verifier_result.passed, true);
    assert.ok(tick.receipt_path, 'verified tick must produce a receipt');

    const res = completeMission(dir, mission.id, tick.receipt_path);
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.mission.status, 'complete');
    assert.equal(payload.mission.completion_gate.ok, true);
    assert.equal(payload.mission.completion_gate.source, 'receipt');
  } finally {
    cleanupTempDir(dir);
  }
});

test('a receipt belonging to another mission is rejected', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    const missionA = startMission(dir, 'mission with real proof', ['--verify', PASSING_VERIFIER]);
    const tickA = tickMission(dir, missionA.id, ['--verify']);
    assert.equal(tickA.verifier_result.passed, true);

    const missionB = startMission(dir, 'mission borrowing proof', ['--verify', PASSING_VERIFIER]);
    const res = completeMission(dir, missionB.id, tickA.receipt_path);
    assert.notEqual(res.status, 0, 'cross-mission receipt must be rejected');
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.ok, false);
    assert.match(payload.error, /mission/i);

    const saved = missionById(dir, missionB.id);
    assert.notEqual(saved.status, 'complete');
  } finally {
    cleanupTempDir(dir);
  }
});

test('a failing tick receipt is rejected as completion proof', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    const mission = startMission(dir, 'blocked mission', ['--verify', FAILING_VERIFIER]);
    const tick = tickMission(dir, mission.id, ['--verify']);
    assert.equal(tick.verifier_result.passed, false);
    assert.ok(tick.receipt_path, 'failed tick still writes a receipt');

    const res = completeMission(dir, mission.id, tick.receipt_path);
    assert.notEqual(res.status, 0, 'failing receipt must be rejected');
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.ok, false);

    const saved = missionById(dir, mission.id);
    assert.notEqual(saved.status, 'complete');
  } finally {
    cleanupTempDir(dir);
  }
});

test('--force overrides the gate and records the forced completion', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    const mission = startMission(dir, 'operator override mission', ['--verify', FAILING_VERIFIER]);

    const res = completeMission(dir, mission.id, 'operator decision: shipping anyway', ['--force']);
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.mission.status, 'complete');
    assert.equal(payload.mission.completion_gate.forced, true);
  } finally {
    cleanupTempDir(dir);
  }
});

test('missions without a verifier complete with free-text proof as before', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    const mission = startMission(dir, 'legacy honor-system mission');

    const res = completeMission(dir, mission.id, 'shipped the doc update');
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.mission.status, 'complete');
    assert.equal(payload.mission.completion_gate.source, 'no_verifier');
  } finally {
    cleanupTempDir(dir);
  }
});
