'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const cli = path.resolve(__dirname, '../bin/atris.js');

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-plain-goal-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'atris/team/mission-lead'), { recursive: true });
  fs.writeFileSync(path.join(root, 'atris/team/mission-lead/MEMBER.md'), '# Mission Lead\n');
  for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.name=test', '-c', 'user.email=test@atris.dev', 'commit', '-qm', 'baseline']]) {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  return root;
}

function run(root, args = [], env = {}) {
  const childEnv = { ...process.env, ATRIS_CALLER_RUNTIME: 'terminal', ATRIS_SKIP_UPDATE_CHECK: '1', ...env };
  for (const key of ['ATRIS_RUNNER_PROFILE', 'ATRIS_RUNNER_COMMAND_TEMPLATE', 'ATRIS_CLAUDE_COMMAND_TEMPLATE']) delete childEnv[key];
  Object.assign(childEnv, env);
  return spawnSync(process.execPath, [cli, 'mission', 'run', 'Save a checked result', '--owner', 'mission-lead', '--no-preflight', '--no-drain', '--max-ticks', '1', ...args, '--json'], {
    cwd: root, env: childEnv, encoding: 'utf8', timeout: 20000,
  });
}

test('a plain terminal goal invokes the configured worker and checks its real output', (t) => {
  const root = workspace(t);
  const worker = path.join(root, 'worker.cjs');
  fs.writeFileSync(worker, "require('node:fs').writeFileSync('result.txt', 'work completed\\n'); console.log('saved result.txt');\n");
  const result = run(root, ['--verify', "node -e \"if(require('fs').readFileSync('result.txt','utf8') !== 'work completed\\n') process.exit(1)\"", '--complete-on-pass'], {
    ATRIS_RUNNER_COMMAND_TEMPLATE: `${process.execPath} ${worker}`,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.action, 'mission_run');
  assert.equal(payload.mission.runner, 'claude');
  assert.equal(payload.ran_ticks, 1);
  assert.equal(payload.ticks[0].verifier_passed, true);
  assert.equal(payload.mission.status, 'complete');
  assert.equal(fs.readFileSync(path.join(root, 'result.txt'), 'utf8'), 'work completed\n');
});

test('an explicit executable runner starts from the same goal command', (t) => {
  const root = workspace(t);
  const result = run(root, ['--runner=drill', '--verify', "node -e \"require('fs').accessSync('.atris/state/drill-runner-touch.txt')\"", '--complete-on-pass']);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ran_ticks, 1);
  assert.equal(payload.mission.runner, 'drill');
  assert.equal(payload.mission.status, 'complete');
  assert.equal(payload.ticks[0].verifier_passed, true);
});

test('a live Codex caller keeps the native goal handoff', (t) => {
  const root = workspace(t);
  const result = run(root, [], { ATRIS_CALLER_RUNTIME: 'codex' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.action, 'mission_run_started');
  assert.equal(payload.mission.runner, 'codex_goal');
  assert.equal(payload.requires_native_goal_start, true);
  assert.equal(payload.native_goal_action.tool, 'create_goal');
  assert.equal(fs.existsSync(path.join(root, 'result.txt')), false);
});

test('an explicit caller runner is preserved from a terminal', (t) => {
  const root = workspace(t);
  const result = run(root, ['--runner', 'codex_goal']);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.action, 'mission_run_started');
  assert.equal(payload.mission.runner, 'codex_goal');
  assert.equal(payload.requires_native_goal_start, true);
});
