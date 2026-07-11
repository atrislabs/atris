const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { missionHeartbeatLines } = require('../commands/mission');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-mission-heartbeat-test-'));
}

function cleanupTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function runCli(args, { cwd, env = {}, timeout = 15000, allowTimeout = false } = {}) {
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
  if (result.error && !(allowTimeout && result.error.code === 'ETIMEDOUT')) throw result.error;
  return result;
}

function startMission(dir, title, extraArgs = []) {
  const res = runCli(['mission', 'start', '--no-verify', title, '--owner', 'mission-lead', '--json', ...extraArgs], { cwd: dir });
  assert.equal(res.status, 0, res.stderr || res.stdout);
  return JSON.parse(res.stdout).mission;
}

function appendMissionState(dir, mission) {
  const stateDir = path.join(dir, '.atris', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.appendFileSync(path.join(stateDir, 'missions.jsonl'), JSON.stringify({
    schema: 'atris.mission.v1',
    owner: 'mission-lead',
    cadence: 'manual',
    lane: 'workspace',
    task_ids: [],
    human_asks: [],
    next_action: 'next move',
    ...mission,
  }) + '\n', 'utf8');
}

test('missionHeartbeatLines reports never-ticked missions as such', () => {
  const lines = missionHeartbeatLines({ status: 'planning', cadence: 'manual' });
  assert.deepEqual(lines, ['  last tick: never']);
});

test('missionHeartbeatLines shows tick age, verifier outcome, and due countdown', () => {
  const now = new Date('2026-06-12T12:00:00Z');
  const lines = missionHeartbeatLines({
    status: 'running',
    cadence: '15m',
    last_tick_at: '2026-06-12T11:55:00Z',
    last_tick_index: 3,
    last_tick_status: 'ran',
    verifier: 'npm test',
    verifier_result: { passed: true },
  }, now);
  assert.equal(lines[0], '  last tick: 5m ago (#3, ran, verifier passed)');
  assert.equal(lines[1], '  due: in 10m');
});

test('missionHeartbeatLines marks overdue always-on missions as due now', () => {
  const now = new Date('2026-06-12T12:00:00Z');
  const lines = missionHeartbeatLines({
    status: 'running',
    cadence: '15m',
    always_on: true,
    last_tick_at: '2026-06-12T11:00:00Z',
    last_tick_status: 'ran',
    verifier: 'npm test',
    verifier_result: { passed: false },
  }, now);
  assert.equal(lines[0], '  last tick: 1h 0m ago (ran, verifier failed)');
  assert.equal(lines[1], '  due: now');
});

test('missionHeartbeatLines shows time left for active full-budget work instead of due now', () => {
  const now = new Date('2026-06-12T12:00:00Z');
  const lines = missionHeartbeatLines({
    status: 'ready',
    cadence: '15m',
    created_at: '2026-06-12T11:00:00Z',
    last_tick_at: '2026-06-12T11:00:00Z',
    last_tick_status: 'ran',
    budget_contract: {
      policy: 'spend_full_budget',
      requested_seconds: 21600,
    },
  }, now);
  assert.equal(lines[0], '  last tick: 1h 0m ago (ran, no verifier)');
  assert.equal(lines[1], '  budget: 5h 0m remaining');
});

test('missionHeartbeatLines stays quiet for terminal missions', () => {
  const lines = missionHeartbeatLines({ status: 'complete', cadence: '15m' });
  assert.deepEqual(lines, []);
});

test('mission status text output includes the heartbeat lines', () => {
  const dir = makeTempDir();
  try {
    const mission = startMission(dir, 'heartbeat text mission');
    appendMissionState(dir, {
      id: mission.id,
      objective: mission.objective,
      status: 'running',
      cadence: '15m',
      last_tick_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      last_tick_index: 1,
      last_tick_status: 'ran',
      verifier: 'npm test',
      verifier_result: { passed: true },
      updated_at: new Date().toISOString(),
    });
    const res = runCli(['mission', 'status', mission.id], { cwd: dir });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /last tick: 5m ago \(#1, ran, verifier passed\)/);
    assert.match(res.stdout, /due: in 10m/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('mission watch prints an initial heartbeat line for a live mission', () => {
  const dir = makeTempDir();
  try {
    const mission = startMission(dir, 'watch heartbeat mission');
    appendMissionState(dir, {
      id: mission.id,
      objective: mission.objective,
      status: 'running',
      cadence: '15m',
      last_tick_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      last_tick_index: 2,
      last_tick_status: 'ran',
      verifier: 'npm test',
      verifier_result: { passed: true },
      updated_at: new Date().toISOString(),
    });
    // watch runs until ctrl+c; the 3s timeout kills it after the first poll lands
    const res = runCli(['mission', 'watch', mission.id], { cwd: dir, timeout: 3000, allowTimeout: true });
    assert.match(res.stdout, /watching .* every 2s/);
    assert.match(res.stdout, /mission-lead .* last tick: 5m ago \(#2, ran, verifier passed\)/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('mission watch emits an idle alive line when nothing changes', () => {
  const dir = makeTempDir();
  try {
    const mission = startMission(dir, 'watch idle mission');
    appendMissionState(dir, {
      id: mission.id,
      objective: mission.objective,
      status: 'running',
      cadence: '15m',
      last_tick_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      last_tick_index: 1,
      last_tick_status: 'ran',
      verifier: 'npm test',
      verifier_result: { passed: true },
      updated_at: new Date().toISOString(),
    });
    // first poll emits the change line; with --idle-every 1 the next quiet poll emits "alive"
    const res = runCli(
      ['mission', 'watch', mission.id, '--interval', '1', '--idle-every', '1'],
      { cwd: dir, timeout: 4000, allowTimeout: true }
    );
    assert.match(res.stdout, /alive, last tick: 5m ago/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('mission watch exits with an error for unknown missions', () => {
  const dir = makeTempDir();
  try {
    startMission(dir, 'watch guard mission');
    const res = runCli(['mission', 'watch', 'mission-does-not-exist'], { cwd: dir });
    assert.equal(res.status, 1, res.stdout);
    assert.match(res.stderr + res.stdout, /not found/);
  } finally {
    cleanupTempDir(dir);
  }
});
