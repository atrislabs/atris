'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { missionHeartbeatLines } = require('../commands/mission');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');
const { withMissionFullJson } = require('./helpers/mission-json');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-mission-run-reliability-'));
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

function runCliAsync(args, cwd, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...withMissionFullJson(args)], {
      cwd,
      env: {
        ...process.env,
        ATRIS_SKIP_UPDATE_CHECK: '1',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr, pid: child.pid }));
  });
}

function prepareWorkspace(dir) {
  fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
}

function startMission(dir, title, extraArgs = []) {
  const hasRunner = extraArgs.some((arg) => arg === '--runner' || String(arg).startsWith('--runner='));
  const result = runCli([
    'mission', 'start', '--no-verify', title,
    '--owner', 'mission-lead',
    ...(hasRunner ? [] : ['--runner', 'manual']),
    ...extraArgs,
    '--json',
  ], dir);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout).mission;
}

function appendMissionState(dir, mission) {
  const stateDir = path.join(dir, '.atris', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.appendFileSync(path.join(stateDir, 'missions.jsonl'), `${JSON.stringify({
    schema: 'atris.mission.v1',
    owner: 'mission-lead',
    lane: 'workspace',
    task_ids: [],
    human_asks: [],
    next_action: 'continue mission',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...mission,
  })}\n`, 'utf8');
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test('duration display carries rounded 60 minutes into the next hour', () => {
  const lines = missionHeartbeatLines({
    status: 'paused',
    cadence: 'manual',
    last_tick_at: '2026-07-18T09:00:29.000Z',
    last_tick_status: 'ran',
  }, new Date('2026-07-18T12:00:00.000Z'));
  assert.equal(lines[0], '  last tick: 3h ago (ran, no verifier)');
});

test('status and doctor identify a stale working mission with a dead detached driver', () => {
  const dir = makeTempDir();
  try {
    prepareWorkspace(dir);
    const mission = {
      id: 'mission-stalled-driver-deadbeef',
      slug: 'stalled-driver',
      objective: 'keep the long mission moving',
      status: 'running',
      cadence: '13m',
      always_on: true,
      verifier: 'node -e "process.exit(0)"',
      last_tick_at: new Date(Date.now() - 50 * 60 * 1000).toISOString(),
      last_tick_status: 'ran',
    };
    appendMissionState(dir, mission);
    const driverState = path.join(dir, '.atris', 'state', 'mission-driver-deadbeef.json');
    fs.writeFileSync(driverState, `${JSON.stringify({
      mission_id: mission.id,
      pid: 2147483647,
      started_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      log_path: 'atris/logs/mission-deadbeef-driver.log',
    })}\n`, 'utf8');

    const status = runCli(['mission', 'status', mission.id], dir);
    assert.equal(status.status, 0, status.stderr || status.stdout);
    assert.match(status.stdout, /stalled: last receipt 50m ago, cadence 13m - driver pid 2147483647 is not alive/);
    assert.match(status.stdout, new RegExp(`restart: atris mission run ${mission.id}`));

    const statusJson = runCli(['mission', 'status', mission.id, '--json'], dir);
    assert.equal(statusJson.status, 0, statusJson.stderr || statusJson.stdout);
    const statusPayload = JSON.parse(statusJson.stdout);
    assert.equal(statusPayload.missions[0].stall.stalled, true);
    assert.equal(statusPayload.missions[0].stall.driver.alive, false);

    const doctor = runCli(['mission', 'doctor', '--local', '--json'], dir);
    assert.equal(doctor.status, 1, doctor.stderr || doctor.stdout);
    const doctorPayload = JSON.parse(doctor.stdout);
    const finding = doctorPayload.findings.find((row) => row.code === 'stalled_driver');
    assert.equal(finding.mission_id, mission.id);
    assert.match(finding.message, /last receipt 50m ago/);

    const doctorText = runCli(['mission', 'doctor', '--local'], dir);
    assert.equal(doctorText.status, 1);
    assert.match(doctorText.stdout, /stalled_driver: keep the long mission moving - stalled:/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('mission run --detach writes driver state and appends to the mission log', () => {
  const dir = makeTempDir();
  let driverPid = null;
  try {
    prepareWorkspace(dir);
    const mission = startMission(dir, 'detach mission driver');
    const detached = runCli([
      'mission', 'run', mission.id,
      '--detach', '--max-ticks', '1', '--no-claude', '--no-verify', '--json',
    ], dir);
    assert.equal(detached.status, 0, detached.stderr || detached.stdout);
    const payload = JSON.parse(detached.stdout);
    driverPid = payload.pid;
    assert.equal(payload.action, 'mission_run_detached');
    assert.equal(payload.mission_id, mission.id);
    assert.equal(Number.isInteger(payload.pid), true);
    assert.equal(payload.log_path, `atris/logs/mission-${mission.id.slice(-8)}-driver.log`);

    const state = JSON.parse(fs.readFileSync(path.join(dir, payload.state_path), 'utf8'));
    assert.equal(state.pid, payload.pid);
    assert.equal(state.mission_id, mission.id);
    assert.equal(fs.existsSync(path.join(dir, payload.log_path)), true);
  } finally {
    if (driverPid) {
      for (let i = 0; i < 100 && processIsAlive(driverPid); i += 1) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a second mission driver exits before spawning a colliding tick', () => {
  const dir = makeTempDir();
  try {
    prepareWorkspace(dir);
    const mission = startMission(dir, 'single mission driver');
    const lockPath = path.join(dir, '.atris', 'state', `mission-${mission.id}.lock`);
    fs.writeFileSync(lockPath, JSON.stringify({
      pid: process.pid,
      started_at: new Date().toISOString(),
      mission_id: mission.id,
    }), 'utf8');

    const result = runCli(['mission', 'run', mission.id, '--no-claude', '--json'], dir);
    assert.equal(result.status, 3);
    assert.equal(
      JSON.parse(result.stdout).error,
      `another driver is already running mission ${mission.id} (pid ${process.pid})`,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the mission lock names the live tick subprocess until it exits', async () => {
  const dir = makeTempDir();
  try {
    prepareWorkspace(dir);
    const runner = path.join(dir, 'slow-claude.js');
    fs.writeFileSync(runner, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('--output-format --permission-mode --resume --session-id --include-partial-messages');
  process.exit(0);
}
const index = args.includes('--session-id') ? args.indexOf('--session-id') : args.indexOf('--resume');
const sessionId = args[index + 1];
setTimeout(() => {
  console.log(JSON.stringify({ type: 'result', session_id: sessionId, result: 'slow tick finished\\nlayer: capabilities', is_error: false, num_turns: 1 }));
}, 1500);
`, 'utf8');
    fs.chmodSync(runner, 0o755);
    const mission = startMission(dir, 'hold the tick subprocess lock', ['--runner', 'claude']);
    const env = { ATRIS_RUNNER_BIN: runner };
    const firstRun = runCliAsync([
      'mission', 'run', mission.id, '--max-ticks', '1', '--no-verify', '--json',
    ], dir, env);
    const lockPath = path.join(dir, '.atris', 'state', `mission-${mission.id}.lock`);
    let lock = null;
    for (let i = 0; i < 100; i += 1) {
      try {
        const candidate = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
        if (candidate.phase === 'tick') {
          lock = candidate;
          break;
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(lock, 'tick subprocess never became the mission lock owner');
    assert.equal(Number.isInteger(lock.pid), true);
    assert.equal(Number.isInteger(lock.driver_pid), true);
    assert.notEqual(lock.pid, lock.driver_pid);

    const secondRun = runCli(['mission', 'run', mission.id, '--no-claude', '--json'], dir, env);
    assert.equal(secondRun.status, 3);
    assert.equal(
      JSON.parse(secondRun.stdout).error,
      `another driver is already running mission ${mission.id} (pid ${lock.pid})`,
    );

    const firstResult = await firstRun;
    assert.equal(firstResult.status, 0, firstResult.stderr || firstResult.stdout);
    assert.equal(fs.existsSync(lockPath), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a busy Claude session retries once with a fresh session without recording an error tick', () => {
  const dir = makeTempDir();
  try {
    prepareWorkspace(dir);
    const runner = path.join(dir, 'fake-claude.js');
    const countFile = path.join(dir, 'runner-count.txt');
    fs.writeFileSync(runner, `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('--output-format --permission-mode --resume --session-id --include-partial-messages');
  process.exit(0);
}
const file = process.env.ATRIS_TEST_RUNNER_COUNT;
const count = fs.existsSync(file) ? Number(fs.readFileSync(file, 'utf8')) + 1 : 1;
fs.writeFileSync(file, String(count));
const sessionIndex = args.includes('--session-id') ? args.indexOf('--session-id') : args.indexOf('--resume');
const sessionId = args[sessionIndex + 1];
if (count === 1) {
  console.error('Session ID ' + sessionId + ' is already in use');
  process.exit(1);
}
console.log(JSON.stringify({ type: 'result', session_id: sessionId, result: 'fresh session completed the tick\\nlayer: capabilities', is_error: false, num_turns: 1 }));
`, 'utf8');
    fs.chmodSync(runner, 0o755);
    const mission = startMission(dir, 'retry a busy claude session', ['--runner', 'claude']);

    const result = runCli([
      'mission', 'run', mission.id,
      '--max-ticks', '1', '--no-verify', '--json',
    ], dir, {
      ATRIS_RUNNER_BIN: runner,
      ATRIS_TEST_RUNNER_COUNT: countFile,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.tick_count, 1);
    assert.equal(payload.ticks[0].status, 'ran');
    assert.equal(payload.ticks[0].reason, 'tick-ok');
    assert.equal(payload.ticks[0].claude.session_busy_retry, true);
    assert.equal(fs.readFileSync(countFile, 'utf8'), '2');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('explicit max-wall wins over a deep tier in mission state and runtime receipts', () => {
  const dir = makeTempDir();
  try {
    prepareWorkspace(dir);
    const startedFromRun = runCli([
      'mission', 'run', 'keep a six hour reliability commitment',
      '--owner', 'mission-lead', '--runner', 'manual',
      '--budget', 'deep', '--max-wall', '21600', '--no-preflight', '--json',
    ], dir);
    assert.equal(startedFromRun.status, 0, startedFromRun.stderr || startedFromRun.stdout);
    const startedPayload = JSON.parse(startedFromRun.stdout);
    assert.equal(startedPayload.mission.max_wall_seconds, 21600);
    assert.equal(startedPayload.budget_contract.requested_seconds, 21600);
    assert.equal(startedPayload.budget_contract.budget_label, '6 hours');
    assert.equal(startedPayload.budget_contract.budget_tier, 'deep');

    const mission = startMission(dir, 'runtime wall override');
    const runtime = runCli([
      'mission', 'run', mission.id,
      '--budget', 'deep', '--max-wall', '21600', '--max-ticks', '1',
      '--no-claude', '--no-verify', '--json',
    ], dir);
    assert.equal(runtime.status, 0, runtime.stderr || runtime.stdout);
    const runtimePayload = JSON.parse(runtime.stdout);
    assert.equal(runtimePayload.budget_contract.requested_seconds, 21600);
    assert.equal(runtimePayload.budget_contract.budget_label, '6 hours');
    assert.equal(runtimePayload.mission.max_wall_seconds, 21600);
    assert.equal(runtimePayload.mission.budget_contract.requested_seconds, 21600);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
