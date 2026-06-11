const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');
const { scrubAgentEnv } = require('./helpers/agent-env');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-mission-xp-test-'));
}

function cleanupTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function runCli(args, { cwd, env = {} } = {}) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 15000,
    env: {
      ...scrubAgentEnv(),
      ATRIS_SKIP_UPDATE_CHECK: '1',
      NODE_NO_WARNINGS: '1',
      ...env,
    },
  });
  if (result.error) throw result.error;
  return result;
}

function hasNodeSqlite() {
  const result = spawnSync(process.execPath, ['-e', 'require("node:sqlite")'], {
    encoding: 'utf8',
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  });
  return result.status === 0;
}

test('mission --xp-task routes verified goal proof into AgentXP acceptance', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, ATRIS_AGENT_ID: 'game-manager' };
  try {
    fs.mkdirSync(path.join(dir, 'atris', 'team', 'game-manager'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'team', 'game-manager', 'MEMBER.md'), '# Game Manager\n');

    const start = runCli([
      'mission', 'start', 'Ship one AgentXP mission loop',
      '--owner', 'game-manager',
      '--runner', 'codex_goal',
      '--lane', 'code',
      '--verify', 'node -e "process.exit(0)"',
      '--stop', 'verifier passes',
      '--xp-task',
      '--json',
    ], { cwd: dir, env });
    assert.equal(start.status, 0, start.stderr || start.stdout);
    const started = JSON.parse(start.stdout);
    const mission = started.mission;
    assert.equal(mission.xp_task_enabled, true);
    assert.ok(mission.xp_task.ref);
    assert.ok(mission.task_ids.includes(mission.xp_task.task_id));

    const list = runCli(['task', 'list', '--json'], { cwd: dir, env });
    assert.equal(list.status, 0, list.stderr || list.stdout);
    const task = JSON.parse(list.stdout).tasks.find(row => row.id === mission.xp_task.task_id);
    assert.equal(task.status, 'claimed');
    assert.equal(task.claimed_by, 'game-manager');
    assert.equal(task.metadata.delegate_via, 'mission_goal_loop');
    assert.equal(task.metadata.goal_id, mission.id);
    assert.equal(task.metadata.goal_objective, 'Ship one AgentXP mission loop');

    const tick = runCli(['mission', 'tick', mission.id, '--verify', '--complete-on-pass', '--json'], { cwd: dir, env });
    assert.equal(tick.status, 0, tick.stderr || tick.stdout);
    const ticked = JSON.parse(tick.stdout);
    assert.equal(ticked.mission.status, 'ready');
    assert.match(ticked.mission.next_action, new RegExp(`atris task current-step --goal-id ${mission.id}`));
    assert.match(ticked.mission.next_action, /--as game-manager/);
    assert.ok(fs.existsSync(path.join(dir, ticked.receipt_path)));

    const goal = runCli(['mission', 'goal', '--json'], { cwd: dir, env });
    assert.equal(goal.status, 0, goal.stderr || goal.stdout);
    assert.match(JSON.parse(goal.stdout).goal.next_command, new RegExp(`atris task current-step --goal-id ${mission.id}`));

    const ready = runCli(['task', 'current-step', '--goal-id', mission.id, '--proof', ticked.receipt_path, '--as', 'game-manager', '--json'], { cwd: dir, env });
    assert.equal(ready.status, 0, ready.stderr || ready.stdout);
    const readyPayload = JSON.parse(ready.stdout);
    assert.equal(readyPayload.action, 'current_step');
    assert.equal(readyPayload.selected_task_id, mission.xp_task.task_id);
    assert.equal(readyPayload.step.step_action, 'ready');
    assert.equal(readyPayload.safety.human_accept, false);
    assert.equal(readyPayload.task.review.approval_status, 'pending');

    const accept = runCli(['task', 'accept', mission.xp_task.ref, '--reward', '2', '--as', 'keshavrao', '--json'], { cwd: dir, env });
    assert.equal(accept.status, 0, accept.stderr || accept.stdout);
    const accepted = JSON.parse(accept.stdout);
    assert.equal(accepted.xp_projection.total_xp, 2);
    assert.equal(accepted.xp_projection.latest_accepted_proof.goal.goal_id, mission.id);
    assert.equal(accepted.xp_projection.latest_accepted_proof.goal.objective, 'Ship one AgentXP mission loop');
  } finally {
    cleanupTempDir(dir);
  }
});
