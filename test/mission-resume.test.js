const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-mission-resume-test-'));
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

function listMissionIds(dir) {
  const res = runCli(['mission', 'status', '--json'], { cwd: dir });
  assert.equal(res.status, 0, res.stderr || res.stdout);
  return JSON.parse(res.stdout).missions.map((m) => m.id);
}

test('mission resume flips a paused mission back to ready and clears pause metadata', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    const mission = startMission(dir, 'resumable mission');

    const paused = runCli(['mission', 'stop', mission.id, '--pause', '--reason', 'overnight budget hit', '--json'], { cwd: dir });
    assert.equal(paused.status, 0, paused.stderr || paused.stdout);
    assert.equal(JSON.parse(paused.stdout).mission.status, 'paused');

    const res = runCli(['mission', 'resume', mission.id, '--reason', 'operator back online', '--json'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.action, 'mission_resumed');
    assert.equal(payload.mission.status, 'ready');
    assert.equal(payload.mission.paused_at, null);
    assert.equal(payload.mission.stop_reason, null);
    assert.ok(payload.mission.resumed_at, 'resume must record a resumed timestamp');
  } finally {
    cleanupTempDir(dir);
  }
});

test('mission resume does not create a junk mission from the natural-language fallback', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    const mission = startMission(dir, 'fallback guard mission');
    const paused = runCli(['mission', 'stop', mission.id, '--pause', '--json'], { cwd: dir });
    assert.equal(paused.status, 0, paused.stderr || paused.stdout);

    const before = listMissionIds(dir);
    const res = runCli(['mission', 'resume', mission.id, '--json'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const after = listMissionIds(dir);
    assert.deepEqual(after.sort(), before.sort(), 'resume must not spawn a new mission');
  } finally {
    cleanupTempDir(dir);
  }
});

test('mission resume on a live mission is a safe no-op', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    const mission = startMission(dir, 'already live mission');

    const res = runCli(['mission', 'resume', mission.id, '--json'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.action, 'mission_resume_noop');
    assert.equal(payload.mission.status, mission.status);
  } finally {
    cleanupTempDir(dir);
  }
});

test('worktree-held missions can be paused, resumed, and stopped from the main checkout', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    const res = runCli(['mission', 'start', 'worktree lifecycle mission', '--owner', 'mission-lead', '--worktree', '--json'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const mission = JSON.parse(res.stdout).mission;
    assert.ok(mission.worktree?.path, 'mission must be bound to a worktree');

    // status/doctor roll worktree missions up; stop/resume/complete must too
    const paused = runCli(['mission', 'stop', mission.id, '--pause', '--json'], { cwd: dir });
    assert.equal(paused.status, 0, paused.stderr || paused.stdout);
    assert.equal(JSON.parse(paused.stdout).mission.status, 'paused');

    const resumed = runCli(['mission', 'resume', mission.id, '--json'], { cwd: dir });
    assert.equal(resumed.status, 0, resumed.stderr || resumed.stdout);
    assert.equal(JSON.parse(resumed.stdout).mission.status, 'ready');

    const stopped = runCli(['mission', 'stop', mission.id, '--reason', 'budget elapsed', '--json'], { cwd: dir });
    assert.equal(stopped.status, 0, stopped.stderr || stopped.stdout);
    assert.equal(JSON.parse(stopped.stdout).mission.status, 'stopped');

    // the state write must land in the mission's own root, not fork into the main one
    const mainState = path.join(dir, '.atris', 'state', 'missions.jsonl');
    const mainRows = fs.existsSync(mainState) ? fs.readFileSync(mainState, 'utf8') : '';
    assert.ok(!mainRows.includes(mission.id), 'worktree mission state must not fork into the main checkout');
  } finally {
    cleanupTempDir(dir);
  }
});

test('mission resume refuses stopped missions', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    const mission = startMission(dir, 'terminal mission');
    const stopped = runCli(['mission', 'stop', mission.id, '--json'], { cwd: dir });
    assert.equal(stopped.status, 0, stopped.stderr || stopped.stdout);

    const res = runCli(['mission', 'resume', mission.id, '--json'], { cwd: dir });
    assert.notEqual(res.status, 0, 'resume on a stopped mission must fail');
  } finally {
    cleanupTempDir(dir);
  }
});
