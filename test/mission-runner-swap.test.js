const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-mission-runner-swap-'));
}

function cleanupTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function runCli(args, { cwd, env = {}, timeout = 30000 } = {}) {
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

function writeFakeCursorAgent(dir) {
  const binDir = path.join(dir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const scriptPath = path.join(binDir, 'cursor-agent');
  fs.writeFileSync(scriptPath, `#!/bin/sh
if [ "$1" = "--help" ]; then
  echo "--output-format --permission-mode --resume --session-id --include-partial-messages"
  exit 0
fi
session=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--session-id" ]; then
    shift
    session="$1"
  fi
  shift || true
done
printf '{"type":"result","session_id":"%s","result":"fake cursor tick\\\\nlayer: capabilities","is_error":false,"num_turns":1}\\n' "$session"
`, 'utf8');
  fs.chmodSync(scriptPath, 0o755);
  return binDir;
}

function startMission(dir, args = []) {
  const res = runCli(['mission', 'start', '--no-verify', 'runner swap mission', '--owner', 'mission-lead', ...args, '--json'], { cwd: dir });
  assert.equal(res.status, 0, res.stderr || res.stdout);
  return JSON.parse(res.stdout).mission;
}

function readMission(dir, id) {
  const res = runCli(['mission', 'status', id, '--json'], { cwd: dir });
  assert.equal(res.status, 0, res.stderr || res.stdout);
  return JSON.parse(res.stdout).missions[0];
}

function writeMissionLock(dir, id) {
  const lockDir = path.join(dir, '.atris', 'state');
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(
    path.join(lockDir, `mission-${id}.lock`),
    JSON.stringify({ pid: process.pid, started_at: '2026-07-05T00:00:00.000Z', mission_id: id }),
    'utf8',
  );
}

test('mission run --engine overrides the stored runner for that run only', () => {
  const dir = makeTempDir();
  try {
    const binDir = writeFakeCursorAgent(dir);
    const env = { PATH: `${binDir}${path.delimiter}${process.env.PATH}` };
    const mission = startMission(dir, ['--runner', 'atris2']);

    const runRes = runCli(['mission', 'run', mission.id, '--engine', 'cursor', '--max-ticks', '1', '--no-verify', '--json'], { cwd: dir, env });
    assert.equal(runRes.status, 0, runRes.stderr || runRes.stdout);
    const payload = JSON.parse(runRes.stdout);
    assert.equal(payload.runner_override.runner, 'cursor');
    assert.equal(payload.runner_override.stored_runner, 'atris2');
    assert.equal(payload.ticks[0].status, 'ran');

    const saved = readMission(dir, mission.id);
    assert.equal(saved.runner, 'atris2');
    assert.equal(saved.model, 'atris:fast');
  } finally {
    cleanupTempDir(dir);
  }
});

test('mission set-runner persists runner, model, and event', () => {
  const dir = makeTempDir();
  try {
    const mission = startMission(dir, ['--runner', 'atris2']);

    const setRes = runCli(['mission', 'set-runner', mission.id, 'cursor', '--model', 'cursor-pro', '--json'], { cwd: dir });
    assert.equal(setRes.status, 0, setRes.stderr || setRes.stdout);
    const payload = JSON.parse(setRes.stdout);
    assert.equal(payload.mission.runner, 'cursor');
    assert.equal(payload.mission.model, 'cursor-pro');

    const saved = readMission(dir, mission.id);
    assert.equal(saved.runner, 'cursor');
    assert.equal(saved.model, 'cursor-pro');

    const eventsPath = path.join(dir, '.atris', 'state', 'mission_events.jsonl');
    const events = fs.readFileSync(eventsPath, 'utf8')
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    const event = events.find((row) => row.type === 'mission_runner_changed');
    assert.ok(event);
    assert.equal(event.payload.previous_runner, 'atris2');
    assert.equal(event.payload.runner, 'cursor');
    assert.equal(event.payload.model, 'cursor-pro');
  } finally {
    cleanupTempDir(dir);
  }
});

test('mission runner swaps reject unknown runners and engines', () => {
  const dir = makeTempDir();
  try {
    const mission = startMission(dir, ['--runner', 'atris2']);

    const setRes = runCli(['mission', 'set-runner', mission.id, 'not-a-runner', '--json'], { cwd: dir });
    assert.equal(setRes.status, 2);
    assert.match(setRes.stdout, /Unknown runner/);

    const runRes = runCli(['mission', 'run', mission.id, '--engine', 'not-an-engine', '--json'], { cwd: dir });
    assert.notEqual(runRes.status, 0);
    assert.match(`${runRes.stdout}${runRes.stderr}`, /Unknown --engine|Unknown engine/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('mission runner swaps refuse while the mission tick lock is held', () => {
  const dir = makeTempDir();
  try {
    const mission = startMission(dir, ['--runner', 'atris2']);
    writeMissionLock(dir, mission.id);

    const setRes = runCli(['mission', 'set-runner', mission.id, 'cursor', '--json'], { cwd: dir });
    assert.equal(setRes.status, 3);
    assert.match(setRes.stdout, /lock busy/);

    const runRes = runCli(['mission', 'run', mission.id, '--engine', 'cursor', '--json'], { cwd: dir });
    assert.equal(runRes.status, 3);
    assert.match(runRes.stdout, /lock busy/);

    const saved = readMission(dir, mission.id);
    assert.equal(saved.runner, 'atris2');
    assert.equal(saved.last_tick_index, undefined);
  } finally {
    cleanupTempDir(dir);
  }
});
