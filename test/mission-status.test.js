const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-mission-status-test-'));
}

function cleanupTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function runCli(args, { cwd } = {}) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 15000,
    env: {
      ...process.env,
      ATRIS_SKIP_UPDATE_CHECK: '1',
    },
  });
  if (result.error) throw result.error;
  return result;
}

function startMission(dir, title) {
  const res = runCli(['mission', 'start', title, '--owner', 'mission-lead', '--json'], { cwd: dir });
  assert.equal(res.status, 0, res.stderr || res.stdout);
  return JSON.parse(res.stdout).mission;
}

test('mission status filters by status and limits list output', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    startMission(dir, 'old planning mission');
    const stopped = startMission(dir, 'stopped mission');
    startMission(dir, 'new planning mission');
    assert.equal(runCli(['mission', 'stop', stopped.id, '--reason', 'done'], { cwd: dir }).status, 0);

    const planning = runCli(['mission', 'status', '--status', 'planning', '--limit', '1', '--json'], { cwd: dir });
    assert.equal(planning.status, 0, planning.stderr || planning.stdout);
    const payload = JSON.parse(planning.stdout);
    assert.equal(payload.missions.length, 1);
    assert.equal(payload.missions[0].objective, 'new planning mission');
    assert.equal(payload.missions[0].status, 'planning');
  } finally {
    cleanupTempDir(dir);
  }
});

test('mission status rejects invalid filters before listing history', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    startMission(dir, 'one mission');

    const badStatus = runCli(['mission', 'status', '--status', 'finished', '--json'], { cwd: dir });
    assert.equal(badStatus.status, 2);
    assert.match(badStatus.stderr, /Invalid --status/);

    const badLimit = runCli(['mission', 'status', '--limit', '0', '--json'], { cwd: dir });
    assert.equal(badLimit.status, 2);
    assert.match(badLimit.stderr, /--limit must be a positive integer/);
  } finally {
    cleanupTempDir(dir);
  }
});
