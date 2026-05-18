const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { selectDueMission, selectCodexGoalMission } = require('../commands/mission');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-mission-status-test-'));
}

function cleanupTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function runCli(args, { cwd } = {}) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 15000,
    env: {
      ...process.env,
      ATRIS_SKIP_UPDATE_CHECK: '1',
    },
  });
  if (result.error) throw result.error;
  return result;
}

function startMission(dir, title) {
  const res = runCli(['mission', 'start', title, '--owner', 'mission-lead', '--json'], { cwd: dir });
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

test('mission status filters by status and limits list output', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    startMission(dir, 'old planning mission');
    const stopped = startMission(dir, 'stopped mission');
    startMission(dir, 'new planning mission');
    assert.equal(runCli(['mission', 'stop', stopped.id, '--reason', 'done'], { cwd: dir }).status, 0);

    const planning = runCli(['mission', 'status', '--status', 'planning', '--limit', '1', '--json'], { cwd: dir });
    assert.equal(planning.status, 0, planning.stderr || planning.stdout);
    const payload = JSON.parse(planning.stdout);
    assert.equal(payload.missions.length, 1);
    assert.equal(payload.missions[0].objective, 'new planning mission');
    assert.equal(payload.missions[0].status, 'planning');

    const active = runCli(['mission', 'status', '--status', 'active', '--json'], { cwd: dir });
    assert.equal(active.status, 0, active.stderr || active.stdout);
    const activePayload = JSON.parse(active.stdout);
    assert.equal(activePayload.missions.length, 2);
    assert.deepEqual(new Set(activePayload.missions.map((mission) => mission.status)), new Set(['planning']));
    assert(!activePayload.missions.some((mission) => ['complete', 'stopped'].includes(mission.status)));
  } finally {
    cleanupTempDir(dir);
  }
});

test('mission status rejects invalid filters before listing history', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    startMission(dir, 'one mission');

    const badStatus = runCli(['mission', 'status', '--status', 'finished', '--json'], { cwd: dir });
    assert.equal(badStatus.status, 2);
    assert.equal(badStatus.stderr, '');
    assert.deepEqual(JSON.parse(badStatus.stdout), {
      ok: false,
      error: 'Invalid --status: finished',
    });

    const badLimit = runCli(['mission', 'status', '--limit', '0', '--json'], { cwd: dir });
    assert.equal(badLimit.status, 2);
    assert.equal(badLimit.stderr, '');
    assert.deepEqual(JSON.parse(badLimit.stdout), {
      ok: false,
      error: '--limit must be a positive integer',
    });

    const missing = runCli(['mission', 'status', 'missing-mission', '--json'], { cwd: dir });
    assert.equal(missing.status, 1);
    assert.equal(missing.stderr, '');
    assert.deepEqual(JSON.parse(missing.stdout), {
      ok: false,
      error: 'Mission "missing-mission" not found.',
    });

    const humanBadStatus = runCli(['mission', 'status', '--status', 'finished'], { cwd: dir });
    assert.equal(humanBadStatus.status, 2);
    assert.equal(humanBadStatus.stdout, '');
    assert.match(humanBadStatus.stderr, /Invalid --status: finished/);

    const humanMissing = runCli(['mission', 'status', 'missing-mission'], { cwd: dir });
    assert.equal(humanMissing.status, 1);
    assert.equal(humanMissing.stdout, '');
    assert.match(humanMissing.stderr, /Mission "missing-mission" not found\./);
  } finally {
    cleanupTempDir(dir);
  }
});

test('mission status normalizes stale terminal next actions', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.atris', 'state'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.atris', 'state', 'missions.jsonl'), JSON.stringify({
      schema: 'atris.mission.v1',
      id: 'legacy-complete',
      slug: 'legacy-complete',
      objective: 'legacy complete mission',
      owner: 'mission-lead',
      status: 'complete',
      verifier: 'npm test',
      next_action: 'run verifier with `atris mission tick <id> --verify`',
      created_at: '2026-05-09T00:00:00.000Z',
      updated_at: '2026-05-09T00:01:00.000Z',
    }) + '\n', 'utf8');

    const status = runCli(['mission', 'status', 'legacy-complete', '--json'], { cwd: dir });
    assert.equal(status.status, 0, status.stderr || status.stdout);
    const statusPayload = JSON.parse(status.stdout);
    assert.equal(statusPayload.missions[0].status, 'complete');
    assert.equal(statusPayload.missions[0].next_action, 'mission complete');

    const tick = runCli(['mission', 'tick', 'legacy-complete', '--json'], { cwd: dir });
    assert.equal(tick.status, 0, tick.stderr || tick.stdout);
    const tickPayload = JSON.parse(tick.stdout);
    assert.equal(tickPayload.mission.status, 'complete');
    assert.equal(tickPayload.mission.next_action, 'mission complete');
  } finally {
    cleanupTempDir(dir);
  }
});

test('mission action missing lookups are JSON-readable', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const cases = [
      ['tick', ['mission', 'tick', 'missing-mission', '--json']],
      ['run', ['mission', 'run', 'missing-mission', '--json']],
      ['complete', ['mission', 'complete', 'missing-mission', '--proof', 'probe', '--json']],
      ['stop', ['mission', 'stop', 'missing-mission', '--json']],
    ];

    for (const [name, args] of cases) {
      const result = runCli(args, { cwd: dir });
      assert.equal(result.status, 1, name);
      assert.equal(result.stderr, '', name);
      assert.deepEqual(JSON.parse(result.stdout), {
        ok: false,
        error: 'Mission "missing-mission" not found.',
      }, name);
    }

    const humanTick = runCli(['mission', 'tick', 'missing-mission'], { cwd: dir });
    assert.equal(humanTick.status, 1);
    assert.equal(humanTick.stdout, '');
    assert.match(humanTick.stderr, /Mission "missing-mission" not found\./);
  } finally {
    cleanupTempDir(dir);
  }
});

test('mission required arguments are JSON-readable', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const cases = [
      [
        'start',
        ['mission', 'start', '--json'],
        'Usage: atris mission start "<objective>" --owner <member> [--verify "..."] [--cadence manual]',
      ],
      [
        'complete',
        ['mission', 'complete', 'missing-mission', '--json'],
        'Usage: atris mission complete <id> --proof "..."',
      ],
      [
        'stop',
        ['mission', 'stop', '--json'],
        'Usage: atris mission stop <id> [--pause] [--reason "..."]',
      ],
    ];

    for (const [name, args, error] of cases) {
      const result = runCli(args, { cwd: dir });
      assert.equal(result.status, 1, name);
      assert.equal(result.stderr, '', name);
      assert.deepEqual(JSON.parse(result.stdout), { ok: false, error }, name);
    }

    const humanStart = runCli(['mission', 'start'], { cwd: dir });
    assert.equal(humanStart.status, 1);
    assert.equal(humanStart.stdout, '');
    assert.match(humanStart.stderr, /Usage: atris mission start/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('mission run terminal skips are JSON-readable', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const stopped = startMission(dir, 'terminal run skip');
    const stop = runCli(['mission', 'stop', stopped.id, '--reason', 'done', '--json'], { cwd: dir });
    assert.equal(stop.status, 0, stop.stderr || stop.stdout);

    const run = runCli(['mission', 'run', '--json'], { cwd: dir });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    assert.equal(run.stderr, '');
    const runPayload = JSON.parse(run.stdout);
    assert.equal(runPayload.ok, true);
    assert.equal(runPayload.action, 'run_skipped');
    assert.equal(runPayload.reason, 'stopped');
    assert.equal(runPayload.mission.id, stopped.id);

    const humanRun = runCli(['mission', 'run', stopped.id], { cwd: dir });
    assert.equal(humanRun.status, 0);
    assert.equal(humanRun.stdout, '');
    assert.match(humanRun.stderr, new RegExp(`Mission ${stopped.id} is stopped; nothing to run\\.`));
  } finally {
    cleanupTempDir(dir);
  }
});

test('mission run --due selects an active verifier mission for loop heartbeats', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    startMission(dir, 'mission without verifier');
    const started = runCli([
      'mission',
      'start',
      'due verifier mission',
      '--owner',
      'mission-lead',
      '--verify',
      'node -e "process.exit(0)"',
      '--json',
    ], { cwd: dir });
    assert.equal(started.status, 0, started.stderr || started.stdout);
    const mission = JSON.parse(started.stdout).mission;

    const due = runCli(['mission', 'run', '--due', '--no-claude', '--complete-on-pass', '--json'], { cwd: dir });
    assert.equal(due.status, 0, due.stderr || due.stdout);
    const payload = JSON.parse(due.stdout);
    assert.equal(payload.action, 'mission_run');
    assert.equal(payload.mission.id, mission.id);
    assert.equal(payload.mission.status, 'complete');
    assert.equal(payload.ticks[0].reason, 'no-claude-mode');
    assert.equal(payload.ticks[0].verifier_passed, true);

    const next = runCli(['mission', 'run', '--due', '--no-claude', '--json'], { cwd: dir });
    assert.equal(next.status, 0, next.stderr || next.stdout);
    assert.deepEqual(JSON.parse(next.stdout), {
      ok: true,
      action: 'run_skipped',
      reason: 'no_due_mission',
      mission: null,
    });
  } finally {
    cleanupTempDir(dir);
  }
});

test('mission run --due skips paused missions', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    appendMissionState(dir, {
      id: 'paused-due',
      slug: 'paused-due',
      objective: 'paused due mission',
      status: 'paused',
      verifier: 'true',
      created_at: '2026-05-01T00:00:00.000Z',
      updated_at: '2026-05-01T00:00:00.000Z',
    });
    appendMissionState(dir, {
      id: 'runnable-due',
      slug: 'runnable-due',
      objective: 'runnable due mission',
      status: 'running',
      verifier: 'true',
      created_at: '2026-05-02T00:00:00.000Z',
      updated_at: '2026-05-02T00:00:00.000Z',
    });

    const due = selectDueMission(dir);
    assert.equal(due.id, 'runnable-due');
  } finally {
    cleanupTempDir(dir);
  }
});

test('mission goal emits the Codex goal candidate from mission state', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    startMission(dir, 'mission without verifier');
    const started = runCli([
      'mission',
      'start',
      'codex visible goal mission',
      '--owner',
      'mission-lead',
      '--runner',
      'codex_goal',
      '--verify',
      'node -e "process.exit(0)"',
      '--json',
    ], { cwd: dir });
    assert.equal(started.status, 0, started.stderr || started.stdout);
    const mission = JSON.parse(started.stdout).mission;

    const selected = selectCodexGoalMission(dir);
    assert.equal(selected.mission.id, mission.id);
    assert.equal(selected.reason, 'due');

    const goal = runCli(['mission', 'goal', '--json'], { cwd: dir });
    assert.equal(goal.status, 0, goal.stderr || goal.stdout);
    const payload = JSON.parse(goal.stdout);
    assert.equal(payload.action, 'codex_goal_candidate');
    assert.equal(payload.goal.mission_id, mission.id);
    assert.equal(payload.goal.reason, 'due');
    assert.equal(fs.realpathSync(payload.state_path), fs.realpathSync(path.join(dir, '.atris', 'state', 'codex_goal.json')));
    assert.equal(fs.realpathSync(payload.status_path), fs.realpathSync(path.join(dir, 'atris', 'status', 'codex-goal.md')));
    assert.match(payload.goal.objective, new RegExp(`Advance Atris mission ${mission.id}: codex visible goal mission`));
    assert.equal(payload.goal.next_command, 'atris mission run --due --max-ticks 1 --complete-on-pass');
    assert.match(payload.goal.replace_after, /replace the Codex \/goal/);
    assert.deepEqual(payload.goal.codex_tool_contract, {
      current_policy: 'keep one visible Codex /goal active for the selected Atris mission',
      read_current_goal: 'get_goal',
      complete_current_goal: 'update_goal({ status: "complete" })',
      select_next_goal: 'atris mission goal --json',
      set_next_goal: 'replace_goal(goal.objective) or create_goal(goal.objective) after the completed goal slot is reusable',
      platform_requirement: 'Codex runtime must expose replace_goal/set_goal, or allow create_goal after update_goal completes the prior goal.',
      blocked_without_platform_goal_write: true,
      mission_id: mission.id,
    });
    const state = JSON.parse(fs.readFileSync(payload.state_path, 'utf8'));
    assert.equal(state.schema, 'atris.codex_goal_controller.v1');
    assert.equal(state.action, 'codex_goal_candidate');
    assert.equal(state.goal.mission_id, mission.id);
    assert.match(fs.readFileSync(payload.status_path, 'utf8'), /Codex Goal Controller/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('mission goal prefers the latest caller-session mission over stale due history', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    appendMissionState(dir, {
      id: 'old-codex-due',
      slug: 'old-codex-due',
      objective: 'old codex goal mission',
      status: 'running',
      runner: 'codex_goal',
      verifier: 'true',
      created_at: '2026-05-01T00:00:00.000Z',
      updated_at: '2026-05-01T00:00:00.000Z',
    });
    appendMissionState(dir, {
      id: 'current-codex-due',
      slug: 'current-codex-due',
      objective: 'current codex goal mission',
      status: 'blocked',
      runner: 'codex_goal',
      verifier: 'true',
      created_at: '2026-05-02T00:00:00.000Z',
      updated_at: '2026-05-02T00:00:00.000Z',
    });

    const selected = selectCodexGoalMission(dir);
    assert.equal(selected.mission.id, 'current-codex-due');
    assert.equal(selected.reason, 'due');
  } finally {
    cleanupTempDir(dir);
  }
});

test('mission goal selects the next active mission after the prior goal mission is complete', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const first = startMission(dir, 'completed codex goal mission');
    const complete = runCli([
      'mission',
      'complete',
      first.id,
      '--proof',
      'done',
      '--json',
    ], { cwd: dir });
    assert.equal(complete.status, 0, complete.stderr || complete.stdout);

    const secondStarted = runCli([
      'mission',
      'start',
      'replacement codex goal mission',
      '--owner',
      'mission-lead',
      '--runner',
      'codex_goal',
      '--verify',
      'node -e "process.exit(0)"',
      '--json',
    ], { cwd: dir });
    assert.equal(secondStarted.status, 0, secondStarted.stderr || secondStarted.stdout);
    const second = JSON.parse(secondStarted.stdout).mission;

    const goal = runCli(['mission', 'goal', '--json'], { cwd: dir });
    assert.equal(goal.status, 0, goal.stderr || goal.stdout);
    const payload = JSON.parse(goal.stdout);
    assert.equal(payload.action, 'codex_goal_candidate');
    assert.equal(payload.goal.mission_id, second.id);
    assert.equal(payload.goal.mission_objective, 'replacement codex goal mission');
    assert.notEqual(payload.goal.mission_id, first.id);
  } finally {
    cleanupTempDir(dir);
  }
});

test('mission completion automatically refreshes Codex goal controller to next mission', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const firstStarted = runCli([
      'mission',
      'start',
      'first codex goal mission',
      '--owner',
      'mission-lead',
      '--runner',
      'codex_goal',
      '--verify',
      'node -e "process.exit(0)"',
      '--json',
    ], { cwd: dir });
    assert.equal(firstStarted.status, 0, firstStarted.stderr || firstStarted.stdout);
    const first = JSON.parse(firstStarted.stdout).mission;

    const secondStarted = runCli([
      'mission',
      'start',
      'next codex goal mission',
      '--owner',
      'mission-lead',
      '--runner',
      'codex_goal',
      '--verify',
      'node -e "process.exit(0)"',
      '--json',
    ], { cwd: dir });
    assert.equal(secondStarted.status, 0, secondStarted.stderr || secondStarted.stdout);
    const second = JSON.parse(secondStarted.stdout).mission;

    const completed = runCli([
      'mission',
      'complete',
      first.id,
      '--proof',
      'done',
      '--json',
    ], { cwd: dir });
    assert.equal(completed.status, 0, completed.stderr || completed.stdout);
    const payload = JSON.parse(completed.stdout);
    assert.equal(payload.mission.status, 'complete');
    assert.equal(payload.codex_goal_state.action, 'codex_goal_candidate');
    assert.equal(payload.codex_goal_state.goal.mission_id, second.id);

    const state = JSON.parse(fs.readFileSync(path.join(dir, '.atris', 'state', 'codex_goal.json'), 'utf8'));
    assert.equal(state.goal.mission_id, second.id);
    assert.notEqual(state.goal.mission_id, first.id);
  } finally {
    cleanupTempDir(dir);
  }
});

test('mission goal heartbeat refreshes controller state without heavy work', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const started = runCli([
      'mission',
      'start',
      'heartbeat codex goal mission',
      '--owner',
      'mission-lead',
      '--runner',
      'codex_goal',
      '--verify',
      'node -e "process.exit(0)"',
      '--json',
    ], { cwd: dir });
    assert.equal(started.status, 0, started.stderr || started.stdout);
    const mission = JSON.parse(started.stdout).mission;

    const heartbeat = runCli(['mission', 'goal', '--heartbeat', '--json'], { cwd: dir });
    assert.equal(heartbeat.status, 0, heartbeat.stderr || heartbeat.stdout);
    const payload = JSON.parse(heartbeat.stdout);
    assert.equal(payload.action, 'codex_goal_heartbeat');
    assert.equal(payload.goal.mission_id, mission.id);
    assert.equal(payload.heartbeat.due, true);
    assert.equal(payload.heartbeat.seconds_until_due, 0);
    assert.equal(payload.heartbeat.recommended_sleep_seconds, 0);
    assert.equal(payload.heartbeat.heavy_work_performed, false);
    assert.equal(payload.heartbeat.next_heavy_command, 'atris mission run --due --max-ticks 1 --complete-on-pass');

    const state = JSON.parse(fs.readFileSync(payload.state_path, 'utf8'));
    assert.equal(state.action, 'codex_goal_heartbeat');
    assert.equal(state.heartbeat.heavy_work_performed, false);
    assert.equal(state.goal.mission_id, mission.id);
  } finally {
    cleanupTempDir(dir);
  }
});

test('mission goal-loop runs due mission work once and refreshes final state', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const started = runCli([
      'mission',
      'start',
      'loop due codex goal mission',
      '--owner',
      'mission-lead',
      '--runner',
      'codex_goal',
      '--verify',
      'node -e "process.exit(0)"',
      '--json',
    ], { cwd: dir });
    assert.equal(started.status, 0, started.stderr || started.stdout);
    const mission = JSON.parse(started.stdout).mission;

    const loop = runCli(['mission', 'goal-loop', '--max-iterations', '1', '--no-claude', '--json'], { cwd: dir });
    assert.equal(loop.status, 0, loop.stderr || loop.stdout);
    const payload = JSON.parse(loop.stdout);
    assert.equal(payload.action, 'codex_goal_loop');
    assert.equal(payload.iterations, 1);
    assert.equal(payload.heavy_runs, 1);
    assert.equal(payload.events[0].heartbeat.goal.mission_id, mission.id);
    assert.equal(payload.events[0].heartbeat.heartbeat.due, true);
    assert.equal(payload.events[0].run.payload.action, 'mission_run');
    assert.equal(payload.events[0].run.payload.mission.id, mission.id);
    assert.equal(payload.events[0].run.payload.mission.status, 'complete');
    assert.equal(payload.final_state.action, 'codex_goal_heartbeat');
    assert.equal(payload.final_state.mission, null);
  } finally {
    cleanupTempDir(dir);
  }
});

test('mission goal reports no candidate when no mission is active', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const mission = startMission(dir, 'finished codex goal');
    const stop = runCli(['mission', 'stop', mission.id, '--reason', 'done', '--json'], { cwd: dir });
    assert.equal(stop.status, 0, stop.stderr || stop.stdout);

    const goal = runCli(['mission', 'goal', '--json'], { cwd: dir });
    assert.equal(goal.status, 0, goal.stderr || goal.stdout);
    const payload = JSON.parse(goal.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.action, 'no_goal_candidate');
    assert.equal(payload.mission, null);
    assert.equal(fs.realpathSync(payload.state_path), fs.realpathSync(path.join(dir, '.atris', 'state', 'codex_goal.json')));
    const state = JSON.parse(fs.readFileSync(payload.state_path, 'utf8'));
    assert.equal(state.action, 'no_goal_candidate');
    assert.equal(state.mission, null);
  } finally {
    cleanupTempDir(dir);
  }
});

test('always-on missions become due again after cadence even after verifier passes', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const started = runCli([
      'mission',
      'start',
      'recurring mission',
      '--owner',
      'mission-lead',
      '--verify',
      'node -e "process.exit(0)"',
      '--always-on',
      '--cadence',
      '1s',
      '--json',
    ], { cwd: dir });
    assert.equal(started.status, 0, started.stderr || started.stdout);

    const firstRun = runCli(['mission', 'run', '--due', '--no-claude', '--complete-on-pass', '--json'], { cwd: dir });
    assert.equal(firstRun.status, 0, firstRun.stderr || firstRun.stdout);
    const firstPayload = JSON.parse(firstRun.stdout);
    assert.equal(firstPayload.mission.status, 'running');
    assert.equal(firstPayload.mission.verifier_result.passed, true);

    const afterCadence = new Date(Date.parse(firstPayload.mission.last_tick_at) + 2000);
    const dueAgain = selectDueMission(dir, afterCadence);
    assert.equal(dueAgain.id, firstPayload.mission.id);
  } finally {
    cleanupTempDir(dir);
  }
});

test('mission lock busy errors are JSON-readable', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const mission = startMission(dir, 'lock busy mission');
    const lockPath = path.join(dir, '.atris', 'state', `mission-${mission.id}.lock`);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({
      pid: 12345,
      started_at: '2026-05-09T00:00:00.000Z',
    }), 'utf8');

    for (const [name, args] of [
      ['run', ['mission', 'run', mission.id, '--no-claude', '--json']],
      ['tick', ['mission', 'tick', mission.id, '--json']],
    ]) {
      const result = runCli(args, { cwd: dir });
      assert.equal(result.status, 3, name);
      assert.equal(result.stderr, '', name);
      const payload = JSON.parse(result.stdout);
      assert.equal(payload.ok, false, name);
      assert.match(payload.error, new RegExp(`\\[mission ${name}\\] lock busy`), name);
    }

    const humanRun = runCli(['mission', 'run', mission.id, '--no-claude'], { cwd: dir });
    assert.equal(humanRun.status, 3);
    assert.equal(humanRun.stdout, '');
    assert.match(humanRun.stderr, /\[mission run\] lock busy/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('mission help documents status filters', () => {
  const dir = makeTempDir();
  try {
    const help = runCli(['mission', '--help'], { cwd: dir });
    assert.equal(help.status, 0, help.stderr || help.stdout);
    assert.match(help.stdout, /mission status \[id\] \[--status <state>\] \[--limit <n>\] \[--json\]/);
    assert.match(help.stdout, /mission goal \[--heartbeat\] \[--json\]/);
    assert.match(help.stdout, /mission goal-loop \[--max-wall 28800\] \[--max-iterations 32\] \[--no-claude\] \[--json\]/);
    assert.match(help.stdout, /Autonomy recipe:/);
    assert.match(help.stdout, /Codex sessions: atris mission goal --json, then set \/goal to goal\.objective/);
    assert.match(help.stdout, /Overnight controller: atris mission goal --heartbeat --json/);
    assert.match(help.stdout, /Bounded overnight runner: atris mission goal-loop --max-wall 28800 --no-claude --json/);
    assert.match(help.stdout, /Headless: start with --runner claude --cadence "15m" --always-on/);
    assert.match(help.stdout, /Backend\/web agents:/);
    assert.match(help.stdout, /--status active shows planning\/running\/ready\/paused\/blocked missions/);
  } finally {
    cleanupTempDir(dir);
  }
});
