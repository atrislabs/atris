const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-mission-budget-tier-test-'));
}

function runCli(args, cwd, env = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 20000,
    env: {
      ...process.env,
      ATRIS_SKIP_UPDATE_CHECK: '1',
      ...env,
    },
  });
}

function prepareWorkspace(dir) {
  fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
}

test('mission start --budget quick stores tier wall and tick budget', () => {
  const dir = makeTempDir();
  try {
    prepareWorkspace(dir);
    const res = runCli([
      'mission', 'start', 'ship a quick proof',
      '--owner', 'tester',
      '--runner', 'manual',
      '--budget', 'quick',
      '--json',
    ], dir);
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.mission.budget_contract.budget_tier, 'quick');
    assert.equal(payload.mission.budget_contract.requested_seconds, 15 * 60);
    assert.equal(payload.mission.max_wall_seconds, 15 * 60);
    assert.equal(payload.mission.max_ticks, 4);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('mission run objective --budget long maps through mission start and max-ticks override wins', () => {
  const dir = makeTempDir();
  try {
    prepareWorkspace(dir);
    const res = runCli([
      'mission', 'run', 'ship a tiered run objective',
      '--owner', 'tester',
      '--runner', 'manual',
      '--budget', 'long',
      '--max-ticks', '2',
      '--no-preflight',
      '--json',
    ], dir);
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.action, 'mission_run_started');
    assert.equal(payload.mission.budget_contract.budget_tier, 'long');
    assert.equal(payload.mission.budget_contract.requested_seconds, 60 * 60);
    assert.equal(payload.mission.max_wall_seconds, 60 * 60);
    assert.equal(payload.mission.max_ticks, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('mission run --budget applies a runtime tier and honors explicit max-ticks', () => {
  const dir = makeTempDir();
  try {
    prepareWorkspace(dir);
    const started = runCli([
      'mission', 'start', 'run a tiered loop',
      '--owner', 'tester',
      '--runner', 'manual',
      '--json',
    ], dir);
    assert.equal(started.status, 0, started.stderr || started.stdout);
    const mission = JSON.parse(started.stdout).mission;

    const run = runCli([
      'mission', 'run', mission.id,
      '--budget', 'deep',
      '--max-ticks', '2',
      '--no-claude',
      '--no-verify',
      '--json',
    ], dir);
    assert.equal(run.status, 0, run.stderr || run.stdout);
    const payload = JSON.parse(run.stdout);
    assert.equal(payload.budget_contract.budget_tier, 'deep');
    assert.equal(payload.budget_contract.requested_seconds, 180 * 60);
    assert.equal(payload.tick_count, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('mission budget rejects unknown tier names', () => {
  const dir = makeTempDir();
  try {
    prepareWorkspace(dir);
    const start = runCli([
      'mission', 'start', 'bad tier',
      '--owner', 'tester',
      '--budget', 'forever',
      '--json',
    ], dir);
    assert.equal(start.status, 2);
    assert.match(JSON.parse(start.stdout).error, /Unknown --budget "forever"/);

    const run = runCli([
      'mission', 'run', 'bad tier run',
      '--budget', 'forever',
      '--json',
    ], dir);
    assert.equal(run.status, 2);
    assert.match(JSON.parse(run.stdout).error, /Unknown --budget "forever"/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
