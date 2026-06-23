const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { businessIdForAtris2Mission } = require('../commands/mission');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-mission-atris2-test-'));
}

function cleanupTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function runCli(args, { cwd, env = {}, timeout = 20000 } = {}) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout,
    env: {
      ...process.env,
      ATRIS_SKIP_UPDATE_CHECK: '1',
      ...env,
    },
  });
  if (result.error) throw result.error;
  return result;
}

test('mission start --runner atris2 defaults model to atris:fast', () => {
  const dir = makeTempDir();
  try {
    const res = runCli(['mission', 'start', 'atris2 default model', '--owner', 'mission-lead', '--runner', 'atris2', '--json'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const mission = JSON.parse(res.stdout).mission;
    assert.equal(mission.runner, 'atris2');
    assert.equal(mission.model, 'atris:fast');
  } finally {
    cleanupTempDir(dir);
  }
});

test('mission start in a business workspace stores business binding for atris2', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, '.atris'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.atris', 'business.json'), JSON.stringify({
      business_id: 'biz-recruiting',
      workspace_id: 'ws-recruiting',
      slug: 'atris-labs',
    }), 'utf8');

    const res = runCli(['mission', 'start', 'recruiting follow-up loop', '--owner', 'justin', '--runner', 'atris2', '--json'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const mission = JSON.parse(res.stdout).mission;
    assert.equal(mission.business_id, 'biz-recruiting');
    assert.equal(mission.workspace_id, 'ws-recruiting');
    assert.equal(businessIdForAtris2Mission(mission, dir), 'biz-recruiting');
    assert.equal(businessIdForAtris2Mission({ runner: 'atris2' }, dir), 'biz-recruiting');
  } finally {
    cleanupTempDir(dir);
  }
});

test('mission start --model is stored verbatim for any runner', () => {
  const dir = makeTempDir();
  try {
    const res = runCli(['mission', 'start', 'explicit model mission', '--owner', 'mission-lead', '--runner', 'claude', '--model', 'claude-haiku-4-5-20251001', '--json'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const mission = JSON.parse(res.stdout).mission;
    assert.equal(mission.runner, 'claude');
    assert.equal(mission.model, 'claude-haiku-4-5-20251001');
  } finally {
    cleanupTempDir(dir);
  }
});

test('mission start without --model stores no model for non-atris2 runners', () => {
  const dir = makeTempDir();
  try {
    const res = runCli(['mission', 'start', 'no model mission', '--owner', 'mission-lead', '--runner', 'claude', '--json'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const mission = JSON.parse(res.stdout).mission;
    assert.equal(mission.model, undefined);
  } finally {
    cleanupTempDir(dir);
  }
});

test('atris2 run without credentials pauses the mission with auth-required', () => {
  const dir = makeTempDir();
  const fakeHome = makeTempDir();
  try {
    const env = { HOME: fakeHome, ATRIS_TOKEN: '', ATRIS_PROFILE: '' };
    const startRes = runCli(['mission', 'start', 'atris2 auth gate', '--owner', 'mission-lead', '--runner', 'atris2', '--verify', 'true', '--json'], { cwd: dir, env });
    assert.equal(startRes.status, 0, startRes.stderr || startRes.stdout);
    const mission = JSON.parse(startRes.stdout).mission;

    const runRes = runCli(['mission', 'run', mission.id, '--max-ticks', '1', '--json'], { cwd: dir, env });
    assert.equal(runRes.status, 0, runRes.stderr || runRes.stdout);

    const statusRes = runCli(['mission', 'status', mission.id, '--json'], { cwd: dir, env });
    const record = JSON.parse(statusRes.stdout).missions[0];
    assert.equal(record.status, 'paused');
    assert.equal(record.stop_reason, 'auth-required');
  } finally {
    cleanupTempDir(dir);
    cleanupTempDir(fakeHome);
  }
});
