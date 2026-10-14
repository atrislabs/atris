const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');
const { withMissionFullJson } = require('./helpers/mission-json');

function makeRepo() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-error-streak-'));
  const repo = path.join(base, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  spawnSync('git', ['init', '-q', '-b', 'master'], { cwd: repo });
  spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: repo });
  spawnSync('git', ['config', 'user.name', 'test'], { cwd: repo });
  return { base, repo };
}

function runCli(args, cwd, extraEnv = {}) {
  const env = { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1' };
  delete env.ATRIS_RUNNER_PROFILE;
  delete env.ATRIS_RUNNER_COMMAND_TEMPLATE;
  delete env.ATRIS_CLAUDE_COMMAND_TEMPLATE;
  delete env.ATRIS_DISPATCH_DEPTH;
  delete env.ATRIS_DISPATCH_MAX_DEPTH;
  Object.assign(env, extraEnv);
  return spawnSync(process.execPath, [cliPath, ...withMissionFullJson(args)], {
    cwd,
    encoding: 'utf8',
    env,
    timeout: 60000,
  });
}

function startMission(repo, objective) {
  const res = runCli([
    'mission', 'start', '--no-verify', objective, '--owner', 'alice', '--runner', 'claude', '--json',
  ], repo);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  return JSON.parse(res.stdout).mission;
}

function writeRunner(repo) {
  const runner = path.join(repo, 'streak-runner.js');
  fs.writeFileSync(runner, `#!/usr/bin/env node
if (process.argv.includes('--help')) {
  process.stdout.write('--output-format --permission-mode --resume --session-id --include-partial-messages\\n');
  process.exit(0);
}
if (process.env.RUNNER_OK === '1') {
  const args = process.argv.slice(2);
  const sessionFlag = args.findIndex((arg) => arg === '--session-id' || arg === '--resume');
  const sessionId = sessionFlag >= 0 ? args[sessionFlag + 1] : '';
  process.stdout.write(JSON.stringify({
    type: 'result',
    session_id: sessionId,
    result: 'worker recovered\\nlayer: capabilities',
  }) + '\\n');
  process.exit(0);
}
process.stderr.write('simulated worker failure\\n');
process.exit(1);
`, 'utf8');
  fs.chmodSync(runner, 0o755);
  return runner;
}

test('a heartbeat mission with one errored tick per run pauses on the second identical failure', () => {
  const { base, repo } = makeRepo();
  try {
    const runner = writeRunner(repo);
    const mission = startMission(repo, 'heartbeat error streak');

    const runOne = runCli([
      'mission', 'run', mission.id, '--no-verify', '--max-ticks', '5', '--max-wall', '3', '--json',
    ], repo, { ATRIS_RUNNER_BIN: runner });
    assert.equal(runOne.status, 0, runOne.stderr || runOne.stdout);
    const first = JSON.parse(runOne.stdout);
    assert.equal(first.ticks[0].status, 'errored');
    assert.equal(first.ticks[0].reason, 'claude-error');
    assert.equal(first.pause_reason, 'max-wall-reached');
    assert.notEqual(first.mission.status, 'paused', 'a single errored run must stay resumable');

    const runTwo = runCli([
      'mission', 'run', mission.id, '--no-verify', '--max-ticks', '5', '--max-wall', '3', '--json',
    ], repo, { ATRIS_RUNNER_BIN: runner });
    assert.equal(runTwo.status, 0, runTwo.stderr || runTwo.stdout);
    const second = JSON.parse(runTwo.stdout);
    assert.equal(second.tick_count, 1, 'the breaker must fire on the first tick of run two');
    assert.equal(second.ticks[0].status, 'errored');
    assert.equal(second.ticks[0].reason, 'claude-error');
    assert.equal(second.pause_reason, 'repeated-error:claude-error');
    assert.equal(second.mission.status, 'paused');
    assert.equal(second.mission.stop_reason, 'repeated-error:claude-error');
    assert.equal(second.mission.error_streak_count, 2);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('a mission that errors once then recovers is not paused and resets the streak', () => {
  const { base, repo } = makeRepo();
  try {
    const runner = writeRunner(repo);
    const mission = startMission(repo, 'error then recover');

    const runOne = runCli([
      'mission', 'run', mission.id, '--no-verify', '--max-ticks', '5', '--max-wall', '3', '--json',
    ], repo, { ATRIS_RUNNER_BIN: runner });
    assert.equal(runOne.status, 0, runOne.stderr || runOne.stdout);
    assert.equal(JSON.parse(runOne.stdout).ticks[0].reason, 'claude-error');

    const runTwo = runCli([
      'mission', 'run', mission.id, '--no-verify', '--max-ticks', '1', '--json',
    ], repo, { ATRIS_RUNNER_BIN: runner, RUNNER_OK: '1' });
    assert.equal(runTwo.status, 0, runTwo.stderr || runTwo.stdout);
    const second = JSON.parse(runTwo.stdout);
    assert.equal(second.ticks[0].status, 'ran');
    assert.notEqual(second.mission.status, 'paused');
    assert.equal(second.mission.error_streak_count, 0);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
