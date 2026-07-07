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

function ackNativeCodexGoal(dir, mission, env = {}) {
  const ack = runCli([
    'mission',
    'goal',
    'ack',
    mission.id,
    '--runtime',
    'codex',
    '--status',
    'active',
    '--objective',
    mission.objective,
    '--json',
  ], { cwd: dir, env });
  assert.equal(ack.status, 0, ack.stderr || ack.stdout);
  return JSON.parse(ack.stdout);
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
      'mission', 'start', '--no-verify', 'Ship one AgentXP mission loop',
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

    const status = runCli(['mission', 'status', mission.id, '--json'], { cwd: dir, env });
    assert.equal(status.status, 0, status.stderr || status.stdout);
    const statusMission = JSON.parse(status.stdout).missions[0];
    assert.equal(statusMission.goal_id, mission.id);
    assert.equal(statusMission.task_id, mission.xp_task.task_id);
    assert.equal(statusMission.current_task_id, mission.xp_task.task_id);
    assert.equal(statusMission.task_ref, mission.xp_task.ref);
    assert.equal(statusMission.task_spine.goal_id, mission.id);
    assert.equal(statusMission.task_spine.owner, 'game-manager');
    assert.equal(statusMission.task_spine.runner, 'codex_goal');
    assert.equal(statusMission.task_spine.lane, 'code');
    assert.match(statusMission.task_spine.current_step_command, new RegExp(`atris task current-step --goal-id ${mission.id}`));
    assert.match(statusMission.task_spine.current_step_command, /--as game-manager/);

    const humanStatus = runCli(['mission', 'status', mission.id], { cwd: dir, env });
    assert.equal(humanStatus.status, 0, humanStatus.stderr || humanStatus.stdout);
    assert.match(humanStatus.stdout, new RegExp(`task: ${mission.xp_task.ref}`));
    // human surfaces use short display refs; the JSON contract above keeps full ids
    assert.match(humanStatus.stdout, /task next: atris task current-step --goal-id \d+ /);

    const nowText = fs.readFileSync(path.join(dir, 'atris', 'team', 'game-manager', 'now.md'), 'utf8');
    assert.match(nowText, new RegExp(`task: ${mission.xp_task.ref}`));
    // now.md is a member boot file: full ids there, short refs on the console
    assert.match(nowText, new RegExp(`task next: atris task current-step --goal-id ${mission.id}`));

    const blockedTick = runCli(['mission', 'tick', mission.id, '--verify', '--complete-on-pass', '--json'], { cwd: dir, env });
    assert.equal(blockedTick.status, 2, blockedTick.stderr || blockedTick.stdout);
    const blockedTickPayload = JSON.parse(blockedTick.stdout);
    assert.equal(blockedTickPayload.code, 'native_goal_not_started');
    assert.match(blockedTickPayload.next_action, /mission goal ack/);

    const ack = ackNativeCodexGoal(dir, mission, env);
    assert.equal(ack.action, 'native_goal_acknowledged');
    assert.equal(ack.codex_goal_state.goal.requires_native_goal_start, false);

    const tick = runCli(['mission', 'tick', mission.id, '--verify', '--complete-on-pass', '--json'], { cwd: dir, env });
    assert.equal(tick.status, 0, tick.stderr || tick.stdout);
    const ticked = JSON.parse(tick.stdout);
    assert.equal(ticked.mission.status, 'ready');
    assert.match(ticked.mission.next_action, new RegExp(`atris task current-step --goal-id ${mission.id}`));
    assert.match(ticked.mission.next_action, /--as game-manager/);
    assert.ok(fs.existsSync(path.join(dir, ticked.receipt_path)));

    const goal = runCli(['mission', 'goal', '--json'], { cwd: dir, env });
    assert.equal(goal.status, 0, goal.stderr || goal.stdout);
    const goalPayload = JSON.parse(goal.stdout);
    assert.match(goalPayload.goal.next_command, new RegExp(`atris task current-step --goal-id ${mission.id}`));
    assert.equal(goalPayload.goal.task_spine.task_ref, mission.xp_task.ref);

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

test('mission attach-task creates a task spine for an existing active mission', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, ATRIS_AGENT_ID: 'game-manager' };
  try {
    fs.mkdirSync(path.join(dir, 'atris', 'team', 'game-manager'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'team', 'game-manager', 'MEMBER.md'), '# Game Manager\n');

    const start = runCli([
      'mission', 'start', '--no-verify', 'Retrofit a mission onto the task board',
      '--owner', 'game-manager',
      '--runner', 'codex_goal',
      '--lane', 'code',
      '--verify', 'node -e "process.exit(0)"',
      '--json',
    ], { cwd: dir, env });
    assert.equal(start.status, 0, start.stderr || start.stdout);
    const mission = JSON.parse(start.stdout).mission;
    assert.equal(mission.xp_task_enabled, false);

    const before = runCli(['mission', 'status', mission.id, '--json'], { cwd: dir, env });
    assert.equal(before.status, 0, before.stderr || before.stdout);
    const beforeMission = JSON.parse(before.stdout).missions[0];
    assert.equal(beforeMission.task_spine.has_task, false);
    assert.equal(beforeMission.task_spine.ensure_task_command, `atris mission attach-task ${mission.id} --json`);

    const beforeText = runCli(['mission', 'status', mission.id], { cwd: dir, env });
    assert.equal(beforeText.status, 0, beforeText.stderr || beforeText.stdout);
    // short display ref in the human hint; verified live: attach-task resolves it
    assert.match(beforeText.stdout, /task setup: atris mission attach-task \d+ --json/);

    const attached = runCli(['mission', 'attach-task', mission.id, '--json'], { cwd: dir, env });
    assert.equal(attached.status, 0, attached.stderr || attached.stdout);
    const payload = JSON.parse(attached.stdout);
    assert.equal(payload.action, 'mission_task_spine_attached');
    assert.equal(payload.mission.xp_task_enabled, true);
    assert.equal(payload.task_spine.has_task, true);
    assert.equal(payload.task_spine.goal_id, mission.id);
    assert.equal(payload.task_spine.owner, 'game-manager');
    assert.equal(payload.task_spine.runner, 'codex_goal');
    assert.equal(payload.task_spine.lane, 'code');
    assert.equal(payload.task_spine.task_ref, payload.task.ref);
    assert.match(payload.task_spine.current_step_command, new RegExp(`atris task current-step --goal-id ${mission.id}`));

    const list = runCli(['task', 'list', '--json'], { cwd: dir, env });
    assert.equal(list.status, 0, list.stderr || list.stdout);
    const task = JSON.parse(list.stdout).tasks.find(row => row.id === payload.task.task_id);
    assert.equal(task.status, 'claimed');
    assert.equal(task.claimed_by, 'game-manager');
    assert.equal(task.metadata.goal_id, mission.id);
    assert.equal(task.metadata.mission_id, mission.id);
    assert.equal(task.metadata.delegate_via, 'mission_goal_loop');

    const status = runCli(['mission', 'status', mission.id, '--json'], { cwd: dir, env });
    assert.equal(status.status, 0, status.stderr || status.stdout);
    const statusMission = JSON.parse(status.stdout).missions[0];
    assert.equal(statusMission.task_ref, payload.task.ref);
    assert.equal(statusMission.task_spine.ensure_task_command, null);

    const beforeAckGoal = runCli(['mission', 'goal', '--json'], { cwd: dir, env });
    assert.equal(beforeAckGoal.status, 0, beforeAckGoal.stderr || beforeAckGoal.stdout);
    const beforeAckGoalPayload = JSON.parse(beforeAckGoal.stdout);
    assert.equal(beforeAckGoalPayload.goal.requires_native_goal_start, true);
    assert.match(beforeAckGoalPayload.goal.next_command, /create_goal/);
    assert.match(beforeAckGoalPayload.goal.next_command, new RegExp(`mission goal ack ${mission.id}`));

    const ack = ackNativeCodexGoal(dir, mission, env);
    assert.equal(ack.codex_goal_state.goal.requires_native_goal_start, false);

    const goal = runCli(['mission', 'goal', '--json'], { cwd: dir, env });
    assert.equal(goal.status, 0, goal.stderr || goal.stdout);
    const goalPayload = JSON.parse(goal.stdout);
    assert.equal(goalPayload.goal.task_spine.task_ref, payload.task.ref);
    assert.equal(goalPayload.goal.task_spine.ensure_task_command, null);
    assert.equal(goalPayload.goal.next_command, 'atris mission run --due --max-ticks 1 --complete-on-pass');

    const again = runCli(['mission', 'task-spine', mission.id, '--json'], { cwd: dir, env });
    assert.equal(again.status, 0, again.stderr || again.stdout);
    const againPayload = JSON.parse(again.stdout);
    assert.equal(againPayload.action, 'mission_task_spine_exists');
    assert.equal(againPayload.task_spine.task_ref, payload.task.ref);
  } finally {
    cleanupTempDir(dir);
  }
});

test('mission attach-task assigns engine-owned missions to functional owners', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, ATRIS_AGENT_ID: 'codex' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const start = runCli([
      'mission', 'start', '--no-verify', 'Watch chat log task signals and infer next action',
      '--owner', 'codex',
      '--runner', 'codex_goal',
      '--lane', 'code',
      '--verify', 'node -e "process.exit(0)"',
      '--json',
    ], { cwd: dir, env });
    assert.equal(start.status, 0, start.stderr || start.stdout);
    const mission = JSON.parse(start.stdout).mission;
    assert.equal(mission.owner, 'signal-scout');
    assert.equal(mission.requested_owner, 'codex');
    assert.equal(mission.executed_by, 'codex');

    const attached = runCli(['mission', 'attach-task', mission.id, '--json'], { cwd: dir, env });
    assert.equal(attached.status, 0, attached.stderr || attached.stdout);
    const payload = JSON.parse(attached.stdout);
    assert.equal(payload.task_spine.owner, 'signal-scout');
    assert.equal(payload.task_spine.requested_owner, 'codex');
    assert.equal(payload.task_spine.executed_by, 'codex');
    assert.equal(payload.task_spine.owner_resolution, 'engine_owner_resolved_by_task_signal');
    assert.match(payload.task_spine.current_step_command, /--as signal-scout/);

    const list = runCli(['task', 'list', '--json'], { cwd: dir, env });
    assert.equal(list.status, 0, list.stderr || list.stdout);
    const task = JSON.parse(list.stdout).tasks.find(row => row.id === payload.task.task_id);
    assert.equal(task.status, 'claimed');
    assert.equal(task.claimed_by, 'signal-scout');
    assert.equal(task.metadata.assigned_to, 'signal-scout');
    assert.equal(task.metadata.executed_by, 'codex');
    assert.equal(task.metadata.requested_owner, 'codex');
    assert.equal(task.metadata.owner_resolution, 'engine_owner_resolved_by_task_signal');
  } finally {
    cleanupTempDir(dir);
  }
});
