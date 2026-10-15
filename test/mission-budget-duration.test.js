const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  durationSecondsFromText,
  wantsFullBudget,
} = require('../commands/mission');
const { withMissionFullJson } = require('./helpers/mission-json');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-mission-budget-duration-test-'));
}

function prepareWorkspace(dir) {
  fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
}

function runCli(args, cwd, env = {}) {
  return spawnSync(process.execPath, [cliPath, ...withMissionFullJson(args)], {
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

test('durationSecondsFromText parses range, compound, and single durations', () => {
  assert.equal(durationSecondsFromText('1-2 hours'), 7200);
  assert.equal(durationSecondsFromText('1-2hours'), 7200);
  assert.equal(durationSecondsFromText('1 to 2 hours'), 7200);
  assert.equal(durationSecondsFromText('30-60 minutes'), 3600);
  assert.equal(durationSecondsFromText('1.5-2h'), 7200);
  assert.equal(durationSecondsFromText('1h 30m'), 5400);
  assert.equal(durationSecondsFromText('1 hour 30 minutes'), 5400);
  assert.equal(durationSecondsFromText('20 minutes'), 1200);
  assert.equal(durationSecondsFromText('5 hours'), 18000);
});

test('wantsFullBudget recognizes over-the-next, tonight, and hour-range durations', () => {
  assert.equal(wantsFullBudget('Fix flaky tests over the next 2 hours', []), true);
  assert.equal(wantsFullBudget('Work for the next 90 minutes', []), true);
  assert.equal(wantsFullBudget('Run for 1-2 hours', []), true);
  assert.equal(wantsFullBudget('Serious work tonight - 1-2hours', []), true);
  assert.equal(wantsFullBudget('Ship tonight for 2 hours', []), true);
  assert.equal(wantsFullBudget('Deep pass 1-2 hours', []), true);
});

test('mission start reads over-the-next duration from the objective as a full-budget contract', () => {
  const dir = makeTempDir();
  try {
    prepareWorkspace(dir);
    const res = runCli([
      'mission', 'start', '--no-verify', 'Fix flaky tests over the next 2 hours',
      '--owner', 'tester',
      '--runner', 'manual',
      '--json',
    ], dir);
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.mission.budget_contract.requested_seconds, 7200);
    assert.equal(payload.mission.budget_contract.policy, 'spend_full_budget');
    assert.equal(payload.mission.max_wall_seconds, 7200);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('mission start reads tonight range duration from the objective as a full-budget contract', () => {
  const dir = makeTempDir();
  try {
    prepareWorkspace(dir);
    const res = runCli([
      'mission', 'start', '--no-verify', 'Serious work tonight - 1-2hours',
      '--owner', 'tester',
      '--runner', 'manual',
      '--json',
    ], dir);
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.mission.budget_contract.requested_seconds, 7200);
    assert.equal(payload.mission.budget_contract.policy, 'spend_full_budget');
    assert.equal(payload.mission.max_wall_seconds, 7200);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('mission start reads short single duration from the objective into budget and wall seconds', () => {
  const dir = makeTempDir();
  try {
    prepareWorkspace(dir);
    const res = runCli([
      'mission', 'start', '--no-verify', 'Quick cleanup for 20 minutes',
      '--owner', 'tester',
      '--runner', 'manual',
      '--json',
    ], dir);
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.mission.budget_contract.requested_seconds, 1200);
    assert.equal(payload.mission.max_wall_seconds, 1200);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('mission start reads compound duration from the objective into budget and wall seconds', () => {
  const dir = makeTempDir();
  try {
    prepareWorkspace(dir);
    const res = runCli([
      'mission', 'start', '--no-verify', 'Run benchmark for 1h 30m',
      '--owner', 'tester',
      '--runner', 'manual',
      '--json',
    ], dir);
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.mission.budget_contract.requested_seconds, 5400);
    assert.equal(payload.mission.max_wall_seconds, 5400);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
