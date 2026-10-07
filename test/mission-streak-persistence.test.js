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
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-streak-persist-'));
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

function startMission(repo, objective, extra = []) {
  const res = runCli([
    'mission', 'start', '--no-verify', objective, '--owner', 'alice', '--runner', 'claude', '--json', ...extra,
  ], repo);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  return JSON.parse(res.stdout).mission;
}

function writeProgressRunner(repo) {
  const runner = path.join(repo, 'progress-runner.js');
  fs.writeFileSync(runner, `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
if (process.argv.includes('--help')) {
  process.stdout.write('--output-format --permission-mode --resume --session-id --include-partial-messages\\n');
  process.exit(0);
}
const n = Date.now();
fs.appendFileSync(path.join(__dirname, 'progress.log'), String(n) + '\\n');
const args = process.argv.slice(2);
const sessionFlag = args.findIndex((arg) => arg === '--session-id' || arg === '--resume');
const sessionId = sessionFlag >= 0 ? args[sessionFlag + 1] : '';
process.stdout.write(JSON.stringify({
  type: 'result',
  session_id: sessionId,
  result: 'edited progress.log\\nlayer: capabilities',
}) + '\\n');
process.exit(0);
`, 'utf8');
  fs.chmodSync(runner, 0o755);
  return runner;
}

function writeIdleRunner(repo) {
  const runner = path.join(repo, 'idle-runner.js');
  fs.writeFileSync(runner, `#!/usr/bin/env node
if (process.argv.includes('--help')) {
  process.stdout.write('--output-format --permission-mode --resume --session-id --include-partial-messages\\n');
  process.exit(0);
}
const args = process.argv.slice(2);
const sessionFlag = args.findIndex((arg) => arg === '--session-id' || arg === '--resume');
const sessionId = sessionFlag >= 0 ? args[sessionFlag + 1] : '';
process.stdout.write(JSON.stringify({
  type: 'result',
  session_id: sessionId,
  result: 'holding tick, no drift\\nlayer: capabilities',
}) + '\\n');
process.exit(0);
`, 'utf8');
  fs.chmodSync(runner, 0o755);
  return runner;
}

test('a heartbeat mission with one idle tick per run stops on the second no-progress tick', () => {
  const { base, repo } = makeRepo();
  try {
    const runner = writeIdleRunner(repo);
    const mission = startMission(repo, 'heartbeat no-progress streak');

    const runOne = runCli([
      'mission', 'run', mission.id, '--no-verify', '--max-ticks', '1', '--max-wall', '10', '--json',
    ], repo, { ATRIS_RUNNER_BIN: runner });
    assert.equal(runOne.status, 0, runOne.stderr || runOne.stdout);
    const first = JSON.parse(runOne.stdout);
    assert.equal(first.ticks[0].status, 'ran');
    assert.notEqual(first.mission.status, 'stopped', 'a single idle run must stay resumable');
    assert.equal(first.mission.no_progress_streak_count, 1);

    const runTwo = runCli([
      'mission', 'run', mission.id, '--no-verify', '--max-ticks', '1', '--max-wall', '10', '--json',
    ], repo, { ATRIS_RUNNER_BIN: runner });
    assert.equal(runTwo.status, 0, runTwo.stderr || runTwo.stdout);
    const second = JSON.parse(runTwo.stdout);
    assert.equal(second.tick_count, 1, 'the breaker must fire on the first tick of run two');
    assert.equal(second.pause_reason, 'no-progress');
    assert.equal(second.mission.status, 'stopped');
    assert.match(second.mission.stop_reason, /^no-progress/);
    assert.equal(second.mission.no_progress_streak_count, 2);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('a heartbeat mission with one verifier fail per run pauses on the second consecutive fail', () => {
  const { base, repo } = makeRepo();
  try {
    const runner = writeProgressRunner(repo);
    const mission = startMission(repo, 'heartbeat verifier-fail streak', ['--verify', `${process.execPath} -e "process.exit(1)"`]);

    const runOne = runCli([
      'mission', 'run', mission.id, '--max-ticks', '1', '--max-wall', '10', '--json',
    ], repo, { ATRIS_RUNNER_BIN: runner });
    assert.equal(runOne.status, 0, runOne.stderr || runOne.stdout);
    const first = JSON.parse(runOne.stdout);
    assert.equal(first.ticks[0].status, 'ran');
    assert.equal(first.ticks[0].verifier_passed, false);
    assert.notEqual(first.mission.status, 'paused', 'a single verifier fail must stay resumable');
    assert.equal(first.mission.verifier_fail_streak_count, 1);

    const runTwo = runCli([
      'mission', 'run', mission.id, '--max-ticks', '1', '--max-wall', '10', '--json',
    ], repo, { ATRIS_RUNNER_BIN: runner });
    assert.equal(runTwo.status, 0, runTwo.stderr || runTwo.stdout);
    const second = JSON.parse(runTwo.stdout);
    assert.equal(second.tick_count, 1, 'the breaker must fire on the first tick of run two');
    assert.equal(second.pause_reason, 'consecutive-verifier-fails');
    assert.equal(second.mission.status, 'paused');
    assert.equal(second.mission.stop_reason, 'consecutive-verifier-fails');
    assert.equal(second.mission.verifier_fail_streak_count, 2);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
