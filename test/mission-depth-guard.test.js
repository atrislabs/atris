const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

function makeRepo() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-depth-guard-'));
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
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    env,
    timeout: 30000,
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
  const runner = path.join(repo, 'depth-runner.js');
  fs.writeFileSync(runner, `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv.includes('--help')) {
  process.stdout.write('--output-format --permission-mode --resume --session-id --include-partial-messages\\n');
  process.exit(0);
}
fs.writeFileSync(process.env.DEPTH_CAPTURE_FILE, process.env.ATRIS_DISPATCH_DEPTH || 'missing');
if (process.argv.includes('generic')) {
  process.stdout.write('generic worker finished\\nlayer: capabilities\\n');
} else {
  const args = process.argv.slice(2);
  const sessionFlag = args.findIndex((arg) => arg === '--session-id' || arg === '--resume');
  const sessionId = sessionFlag >= 0 ? args[sessionFlag + 1] : '';
  process.stdout.write(JSON.stringify({
    type: 'result',
    session_id: sessionId,
    result: 'claude worker finished\\nlayer: capabilities',
  }) + '\\n');
}
`, 'utf8');
  fs.chmodSync(runner, 0o755);
  return runner;
}

test('generic and claude workers receive the incremented dispatch depth', () => {
  const { base, repo } = makeRepo();
  try {
    const runner = writeRunner(repo);

    const genericMission = startMission(repo, 'generic depth propagation');
    const genericCapture = path.join(repo, 'generic-depth.txt');
    const genericRun = runCli([
      'mission', 'run', genericMission.id, '--no-verify', '--max-ticks', '1', '--json',
    ], repo, {
      ATRIS_RUNNER_COMMAND_TEMPLATE: `${process.execPath} ${JSON.stringify(runner)} generic`,
      DEPTH_CAPTURE_FILE: genericCapture,
    });
    assert.equal(genericRun.status, 0, genericRun.stderr || genericRun.stdout);
    assert.equal(JSON.parse(genericRun.stdout).ticks[0].status, 'ran');
    assert.equal(fs.readFileSync(genericCapture, 'utf8'), '1');

    const claudeMission = startMission(repo, 'claude depth propagation');
    const claudeCapture = path.join(repo, 'claude-depth.txt');
    const claudeRun = runCli([
      'mission', 'run', claudeMission.id, '--no-verify', '--max-ticks', '1', '--json',
    ], repo, {
      ATRIS_RUNNER_BIN: runner,
      DEPTH_CAPTURE_FILE: claudeCapture,
    });
    assert.equal(claudeRun.status, 0, claudeRun.stderr || claudeRun.stdout);
    assert.equal(JSON.parse(claudeRun.stdout).ticks[0].status, 'ran');
    assert.equal(fs.readFileSync(claudeCapture, 'utf8'), '1');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('the default depth cap refuses a worker and pauses after recording the tick error', () => {
  const { base, repo } = makeRepo();
  try {
    const runner = writeRunner(repo);
    const mission = startMission(repo, 'depth refusal');
    const capture = path.join(repo, 'refused-depth.txt');
    const run = runCli([
      'mission', 'run', mission.id, '--no-verify', '--max-ticks', '5', '--json',
    ], repo, {
      ATRIS_RUNNER_BIN: runner,
      ATRIS_DISPATCH_DEPTH: '2',
      DEPTH_CAPTURE_FILE: capture,
    });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    const payload = JSON.parse(run.stdout);

    assert.equal(payload.tick_count, 1);
    assert.equal(payload.ticks[0].status, 'errored');
    assert.equal(payload.ticks[0].reason, 'too-deep');
    assert.equal(payload.pause_reason, 'too-deep');
    assert.equal(payload.mission.status, 'paused');
    assert.equal(payload.mission.stop_reason, 'too-deep');
    assert.equal(payload.mission.next_action, 'stopped: helpers were spawning helpers too many levels deep');
    assert.equal(fs.existsSync(capture), false, 'the refused worker must not spawn');

    const genericMission = startMission(repo, 'generic depth refusal');
    const genericCapture = path.join(repo, 'refused-generic-depth.txt');
    const genericRun = runCli([
      'mission', 'run', genericMission.id, '--no-verify', '--max-ticks', '5', '--json',
    ], repo, {
      ATRIS_RUNNER_BIN: process.execPath,
      ATRIS_RUNNER_COMMAND_TEMPLATE: `${process.execPath} ${JSON.stringify(runner)} generic`,
      ATRIS_DISPATCH_DEPTH: '2',
      DEPTH_CAPTURE_FILE: genericCapture,
    });
    assert.equal(genericRun.status, 0, genericRun.stderr || genericRun.stdout);
    const genericPayload = JSON.parse(genericRun.stdout);
    assert.equal(genericPayload.tick_count, 1);
    assert.equal(genericPayload.ticks[0].reason, 'too-deep');
    assert.equal(genericPayload.pause_reason, 'too-deep');
    assert.equal(genericPayload.mission.status, 'paused');
    assert.equal(fs.existsSync(genericCapture), false, 'the refused generic worker must not spawn');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('ATRIS_DISPATCH_MAX_DEPTH overrides the default cap', () => {
  const { base, repo } = makeRepo();
  try {
    const runner = writeRunner(repo);
    const mission = startMission(repo, 'depth override');
    const capture = path.join(repo, 'override-depth.txt');
    const run = runCli([
      'mission', 'run', mission.id, '--no-verify', '--max-ticks', '1', '--json',
    ], repo, {
      ATRIS_RUNNER_BIN: runner,
      ATRIS_DISPATCH_DEPTH: '2',
      ATRIS_DISPATCH_MAX_DEPTH: '3',
      DEPTH_CAPTURE_FILE: capture,
    });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    const payload = JSON.parse(run.stdout);

    assert.equal(payload.ticks[0].status, 'ran');
    assert.equal(payload.pause_reason, null);
    assert.equal(fs.readFileSync(capture, 'utf8'), '3');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
