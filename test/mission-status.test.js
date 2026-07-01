const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const {
  cappedClaudeReceiptText,
  selectDueMission,
  selectCodexGoalMission,
  usefulClaudeReceiptSummary,
} = require('../commands/mission');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-mission-status-test-'));
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
      ...process.env,
      ATRIS_SKIP_UPDATE_CHECK: '1',
      ...env,
    },
  });
  if (result.error) throw result.error;
  return result;
}

function runCliAsync(args, { cwd, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
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
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', status => resolve({ status, stdout, stderr }));
  });
}

function readSummaryReceipt(dir, stdout) {
  const match = stdout.match(/Proof: Summary receipt saved at (.+?\.json)\./);
  assert.ok(match, stdout);
  return JSON.parse(fs.readFileSync(path.join(dir, match[1]), 'utf8'));
}

function hasNodeSqlite() {
  const result = spawnSync(process.execPath, ['-e', 'require("node:sqlite")'], {
    encoding: 'utf8',
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  });
  return result.status === 0;
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

test('Claude mission receipt summaries skip generic markdown headings', () => {
  const text = [
    '## Receipt',
    '',
    '- Edited atris/runs/bounty-lane/targets-2026-05-10.md with a fresh scoped sweep.',
    '- Next tick: monitor payout surfaces only.',
  ].join('\n');

  assert.equal(
    usefulClaudeReceiptSummary(text),
    'Edited atris/runs/bounty-lane/targets-2026-05-10.md with a fresh scoped sweep.',
  );
  assert.match(cappedClaudeReceiptText(text), /Next tick: monitor payout surfaces only/);
});

test('mission run JSON preserves useful Claude receipt text', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const binDir = path.join(dir, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    const fakeClaude = path.join(binDir, 'claude');
    fs.writeFileSync(fakeClaude, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('--output-format --permission-mode --resume --session-id --include-partial-messages');
  process.exit(0);
}
const sessionFlag = args.includes('--session-id') ? '--session-id' : '--resume';
const sessionId = args[args.indexOf(sessionFlag) + 1] || 'fake-session';
console.log(JSON.stringify({ type: 'system', session_id: sessionId }));
console.log(JSON.stringify({
  type: 'result',
  session_id: sessionId,
  result: '## Receipt\\n- Edited atris/runs/bounty-lane/targets-2026-05-10.md with a fresh scoped sweep.\\n- Next tick: monitor payout surfaces only.',
  total_cost_usd: 0.01,
  duration_api_ms: 2,
  num_turns: 1
}));
`, 'utf8');
    fs.chmodSync(fakeClaude, 0o755);

    const started = runCli([
      'mission',
      'start',
      'fake claude receipt mission',
      '--owner',
      'mission-lead',
      '--verify',
      'node -e "process.exit(0)"',
      '--json',
    ], { cwd: dir });
    assert.equal(started.status, 0, started.stderr || started.stdout);
    const mission = JSON.parse(started.stdout).mission;
    const run = runCli(['mission', 'run', mission.id, '--max-ticks', '1', '--json'], {
      cwd: dir,
      env: { PATH: `${binDir}:${process.env.PATH}` },
    });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    assert.equal(run.stderr, '');
    assert.equal(run.stdout.trimStart().startsWith('{'), true);
    const payload = JSON.parse(run.stdout);
    assert.equal(payload.ticks[0].claude.summary, 'Edited atris/runs/bounty-lane/targets-2026-05-10.md with a fresh scoped sweep.');
    assert.match(payload.ticks[0].claude.receipt_text, /## Receipt/);
    assert.match(payload.ticks[0].claude.receipt_text, /Next tick: monitor payout surfaces only/);
  } finally {
    cleanupTempDir(dir);
  }
});

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

test('mission doctor flags no-verifier, help, stale ready receipts, and blocked always-on loops', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    appendMissionState(dir, {
      id: 'mission-no-verifier',
      slug: 'mission-no-verifier',
      objective: 'ship without proof',
      status: 'planning',
      verifier: '',
      created_at: '2026-06-30T00:00:00.000Z',
      updated_at: '2026-06-30T00:00:00.000Z',
    });
    appendMissionState(dir, {
      id: 'mission-help',
      slug: 'mission-help',
      objective: '--help',
      status: 'planning',
      verifier: '',
      created_at: '2026-06-30T00:01:00.000Z',
      updated_at: '2026-06-30T00:01:00.000Z',
    });
    appendMissionState(dir, {
      id: 'mission-stale-ready',
      slug: 'mission-stale-ready',
      objective: 'ready with stale receipt',
      status: 'ready',
      verifier: 'node -e "process.exit(0)"',
      verifier_result: { passed: true, command: 'node -e "process.exit(0)"' },
      receipt_path: 'atris/runs/missing-ready-receipt.json',
      created_at: '2026-06-30T00:02:00.000Z',
      updated_at: '2026-06-30T00:02:00.000Z',
    });
    appendMissionState(dir, {
      id: 'mission-blocked-always-on',
      slug: 'mission-blocked-always-on',
      objective: 'blocked overnight loop',
      status: 'blocked',
      always_on: true,
      verifier: 'node -e "process.exit(1)"',
      verifier_result: { passed: false, command: 'node -e "process.exit(1)"' },
      created_at: '2026-06-30T00:03:00.000Z',
      updated_at: '2026-06-30T00:03:00.000Z',
    });

    const doctor = runCli(['mission', 'doctor', '--local', '--json'], { cwd: dir });
    assert.equal(doctor.status, 1);
    assert.equal(doctor.stderr, '');
    const payload = JSON.parse(doctor.stdout);
    assert.equal(payload.ok, false);
    assert.equal(payload.action, 'mission_doctor');
    assert.equal(payload.checked_count, 4);
    assert.equal(payload.finding_count, 5);
    const codes = payload.findings.map((finding) => finding.code);
    assert(codes.includes('missing_verifier'));
    assert(codes.includes('accidental_help_mission'));
    assert(codes.includes('stale_ready_receipt'));
    assert(codes.includes('blocked_always_on_loop'));

    const human = runCli(['mission', 'doctor', '--local'], { cwd: dir });
    assert.equal(human.status, 1);
    assert.match(human.stdout, /Mission doctor: 5 problem\(s\) across 4 mission\(s\)/);
    assert.match(human.stdout, /missing_verifier/);
    assert.match(human.stdout, /accidental_help_mission/);
    assert.match(human.stdout, /stale_ready_receipt/);
    assert.match(human.stdout, /blocked_always_on_loop/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('mission doctor passes clean terminal and fresh ready missions', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris', 'runs'), { recursive: true });
    const receiptPath = path.join('atris', 'runs', 'passed-ready-receipt.json');
    fs.writeFileSync(path.join(dir, receiptPath), JSON.stringify({
      schema: 'atris.mission_receipt.v1',
      mission_id: 'mission-fresh-ready',
      result: {
        passed: true,
        verifier_result: { passed: true, command: 'node -e "process.exit(0)"' },
      },
    }, null, 2), 'utf8');
    appendMissionState(dir, {
      id: 'mission-fresh-ready',
      slug: 'mission-fresh-ready',
      objective: 'fresh ready mission',
      status: 'ready',
      verifier: 'node -e "process.exit(0)"',
      verifier_result: { passed: true, command: 'node -e "process.exit(0)"' },
      receipt_path: receiptPath,
      created_at: '2026-06-30T00:00:00.000Z',
      updated_at: '2026-06-30T00:00:00.000Z',
    });
    appendMissionState(dir, {
      id: 'mission-complete-no-verifier',
      slug: 'mission-complete-no-verifier',
      objective: 'old manual mission',
      status: 'complete',
      verifier: '',
      created_at: '2026-06-30T00:01:00.000Z',
      updated_at: '2026-06-30T00:01:00.000Z',
    });

    const doctor = runCli(['mission', 'doctor', '--local', '--json'], { cwd: dir });
    assert.equal(doctor.status, 0, doctor.stderr || doctor.stdout);
    const payload = JSON.parse(doctor.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.checked_count, 2);
    assert.equal(payload.finding_count, 0);
  } finally {
    cleanupTempDir(dir);
  }
});

test('mission doctor accepts legacy overnight self-improve missions with default verifier', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    appendMissionState(dir, {
      id: 'mission-legacy-overnight',
      slug: 'mission-legacy-overnight',
      objective: 'work overnight and see where we can self improve. goal after goal nonstop 6 hours',
      owner: 'auto-improver',
      status: 'running',
      runner: 'codex_goal',
      always_on: true,
      cadence: '13m',
      verifier: '',
      overnight_loop: { requested_hours: 6, cadence: '13m' },
      native_goal_ack: {
        runtime: 'codex',
        status: 'active',
        objective: 'work overnight and see where we can self improve. goal after goal nonstop 6 hours',
      },
      created_at: '2026-06-30T12:00:00.000Z',
      updated_at: '2026-06-30T12:00:00.000Z',
    });

    const doctor = runCli(['mission', 'doctor', '--local', '--json'], { cwd: dir });
    assert.equal(doctor.status, 0, doctor.stderr || doctor.stdout);
    const payload = JSON.parse(doctor.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.finding_count, 0);

    const status = runCli(['mission', 'status', 'mission-legacy-overnight', '--json'], { cwd: dir });
    assert.equal(status.status, 0, status.stderr || status.stdout);
    const statusPayload = JSON.parse(status.stdout);
    assert.equal(statusPayload.missions[0].verifier, '');
    assert.equal(statusPayload.missions[0].effective_verifier, 'git diff --check');
  } finally {
    cleanupTempDir(dir);
  }
});

test('always-on mission next action does not suggest completion flag', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const started = runCli([
      'mission',
      'start',
      'watchdog mission',
      '--owner',
      'mission-lead',
      '--runner',
      'codex_goal',
      '--verify',
      'node -e "process.exit(0)"',
      '--always-on',
      '--json',
    ], { cwd: dir });
    assert.equal(started.status, 0, started.stderr || started.stdout);
    const mission = JSON.parse(started.stdout).mission;
    assert.match(mission.next_action, new RegExp(`atris mission run ${mission.id}`));
    assert.doesNotMatch(mission.next_action, /--complete-on-pass/);

    const initialGoal = runCli(['mission', 'goal', '--json'], { cwd: dir });
    assert.equal(initialGoal.status, 0, initialGoal.stderr || initialGoal.stdout);
    const initialGoalPayload = JSON.parse(initialGoal.stdout);
    assert.equal(initialGoalPayload.goal.mission_id, mission.id);
    assert.match(initialGoalPayload.goal.next_command, /create_goal/);
    assert.match(initialGoalPayload.goal.next_command, new RegExp(`mission goal ack ${mission.id}`));
    assert.doesNotMatch(initialGoalPayload.goal.next_command, /--complete-on-pass/);

    ackNativeCodexGoal(dir, mission);

    const goal = runCli(['mission', 'goal', '--json'], { cwd: dir });
    assert.equal(goal.status, 0, goal.stderr || goal.stdout);
    const goalPayload = JSON.parse(goal.stdout);
    assert.equal(goalPayload.goal.mission_id, mission.id);
    assert.equal(goalPayload.goal.next_command, `atris mission attach-task ${mission.id} --json`);
    assert.doesNotMatch(goalPayload.goal.next_command, /--complete-on-pass/);

    const heartbeat = runCli(['mission', 'goal', '--heartbeat', '--json'], { cwd: dir });
    assert.equal(heartbeat.status, 0, heartbeat.stderr || heartbeat.stdout);
    const heartbeatPayload = JSON.parse(heartbeat.stdout);
    assert.equal(heartbeatPayload.goal.mission_id, mission.id);
    assert.equal(heartbeatPayload.heartbeat.next_heavy_command, `atris mission attach-task ${mission.id} --json`);
    assert.doesNotMatch(heartbeatPayload.heartbeat.next_heavy_command, /--complete-on-pass/);

    const tick = runCli(['mission', 'tick', mission.id, '--verify', '--complete-on-pass', '--json'], { cwd: dir });
    assert.equal(tick.status, 0, tick.stderr || tick.stdout);
    const tickPayload = JSON.parse(tick.stdout);
    assert.equal(tickPayload.mission.status, 'ready');
    assert.match(tickPayload.mission.next_action, new RegExp(`atris mission run ${mission.id}`));
    assert.doesNotMatch(tickPayload.mission.next_action, /--complete-on-pass/);

    const humanTick = runCli(['mission', 'tick', mission.id, '--verify', '--summary', 'Finished the next watchdog proof step'], { cwd: dir });
    assert.equal(humanTick.status, 0, humanTick.stderr || humanTick.stdout);
    assert.match(humanTick.stdout, /Changed: Finished the next watchdog proof step\./);
    assert.match(humanTick.stdout, /Next: Run the next proof step\./);
    assert.doesNotMatch(humanTick.stdout, /complete the mission/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('mission goal keeps always-on ready missions running after xp proof', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const now = new Date().toISOString();
    appendMissionState(dir, {
      id: 'always-on-ready-xp',
      slug: 'always-on-ready-xp',
      objective: 'always-on ready xp mission',
      status: 'ready',
      runner: 'codex_goal',
      verifier: 'true',
      always_on: true,
      cadence: '1h',
      receipt_path: 'atris/runs/always-on-ready-xp.json',
      next_action: 'next move: run atris mission run always-on-ready-xp',
      xp_task_enabled: true,
      xp_task: {
        task_id: 'task-always-on-ready-xp',
        ref: 'CLI-999',
        status: 'claimed',
        assigned_to: 'mission-lead',
      },
      task_ids: ['task-always-on-ready-xp'],
      native_goal_ack: {
        runtime: 'codex',
        status: 'active',
        objective: 'always-on ready xp mission',
        acknowledged_at: now,
      },
      last_tick_at: now,
      last_tick_status: 'ran',
      last_tick_reason: 'tick-recorded',
      last_tick_index: 7,
      verifier_result: {
        command: 'true',
        status: 0,
        passed: true,
        stdout: '',
        stderr: '',
      },
      created_at: now,
      updated_at: now,
    });

    const goal = runCli(['mission', 'goal', '--json'], { cwd: dir });
    assert.equal(goal.status, 0, goal.stderr || goal.stdout);
    const payload = JSON.parse(goal.stdout);
    assert.equal(payload.goal.mission_id, 'always-on-ready-xp');
    assert.equal(payload.goal.mission_status, 'ready');
    assert.equal(payload.goal.task_spine.has_task, true);
    assert.equal(payload.goal.next_command, 'atris mission run always-on-ready-xp');
    assert.doesNotMatch(payload.goal.next_command, /task current-step/);

    const heartbeat = runCli(['mission', 'goal', '--heartbeat', '--json'], { cwd: dir });
    assert.equal(heartbeat.status, 0, heartbeat.stderr || heartbeat.stdout);
    const heartbeatPayload = JSON.parse(heartbeat.stdout);
    assert.equal(heartbeatPayload.heartbeat.due, false);
    assert.equal(heartbeatPayload.heartbeat.next_heavy_command, 'atris mission run always-on-ready-xp');
  } finally {
    cleanupTempDir(dir);
  }
});

test('mission tick can write a passing ad hoc verifier receipt', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const started = runCli([
      'mission',
      'start',
      'ad hoc verifier receipt mission',
      '--owner',
      'mission-lead',
      '--json',
    ], { cwd: dir });
    assert.equal(started.status, 0, started.stderr || started.stdout);
    const mission = JSON.parse(started.stdout).mission;
    assert.equal(mission.verifier, '');

    const verifier = 'node -e "process.exit(0)"';
    const tick = runCli([
      'mission',
      'tick',
      mission.id,
      '--verify',
      verifier,
      '--summary',
      'proof command passed',
      '--json',
    ], { cwd: dir });
    assert.equal(tick.status, 0, tick.stderr || tick.stdout);
    const payload = JSON.parse(tick.stdout);
    assert.equal(payload.verifier_result.passed, true);
    assert.equal(payload.verifier_result.command, verifier);
    assert.equal(payload.mission.verifier, '');
    assert.equal(payload.mission.verifier_result.passed, true);
    assert.equal(payload.mission.verifier_result.command, verifier);

    const receipt = JSON.parse(fs.readFileSync(path.join(dir, payload.receipt_path), 'utf8'));
    assert.equal(receipt.verifier, null);
    assert.equal(receipt.result.frozen.verifier, verifier);
    assert.equal(receipt.result.verifier_result.passed, true);
    assert.equal(receipt.result.verifier_result.command, verifier);
    assert.equal(receipt.result.passed, true);
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

test('mission complete emits a human-readable landing receipt', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const started = runCli([
      'mission',
      'start',
      'json complete receipt mission',
      '--owner',
      'mission-lead',
      '--verify',
      'node -e "process.exit(0)"',
      '--json',
    ], { cwd: dir });
    assert.equal(started.status, 0, started.stderr || started.stdout);
    const mission = JSON.parse(started.stdout).mission;
    const tick = runCli(['mission', 'tick', mission.id, '--verify', '--json'], { cwd: dir });
    assert.equal(tick.status, 0, tick.stderr || tick.stdout);
    const receiptPath = JSON.parse(tick.stdout).receipt_path;

    const completed = runCli(['mission', 'complete', mission.id, '--proof', receiptPath, '--json'], { cwd: dir });
    assert.equal(completed.status, 0, completed.stderr || completed.stdout);
    const payload = JSON.parse(completed.stdout);
    assert.equal(payload.action, 'mission_completed');
    assert.equal(payload.mission.status, 'complete');
    assert.equal(payload.landing.happened, 'json complete receipt mission is complete.');
    assert.match(payload.landing.checked, /passing verifier receipt/);
    assert.match(payload.landing.tested, /Verifier passed: node -e "process\.exit\(0\)"/);
    assert.match(payload.result.saved, /Proof saved at/);
    assert.match(payload.landing.artifact, /^Open timeline at atris\/runs\/mission-/);
    assert.match(payload.result.artifact, /^atris\/runs\/mission-/);
    assert.equal(fs.existsSync(path.join(dir, payload.artifact.index_html)), true);
    assert.equal(fs.existsSync(path.join(dir, payload.artifact.index_md)), true);
    assert.equal(fs.existsSync(path.join(dir, payload.artifact.blocks_json)), true);
    assert.equal(fs.existsSync(path.join(dir, payload.artifact.raw_json)), true);
    const blocks = JSON.parse(fs.readFileSync(path.join(dir, payload.artifact.blocks_json), 'utf8'));
    const timeline = blocks.blocks.find((block) => block.type === 'timeline');
    assert.equal(Boolean(timeline), true);
    assert(timeline.items.some((item) => item.title === 'Goal 1 done'));
    assert.equal(timeline.items.at(-1).title, 'Mission accomplished');
    assert.equal(payload.mission.landing.happened, payload.landing.happened);
    assert.equal(payload.mission.result.saved, payload.result.saved);

    const humanStarted = runCli([
      'mission',
      'start',
      'human complete receipt mission',
      '--owner',
      'mission-lead',
      '--verify',
      'node -e "process.exit(0)"',
      '--json',
    ], { cwd: dir });
    assert.equal(humanStarted.status, 0, humanStarted.stderr || humanStarted.stdout);
    const humanMission = JSON.parse(humanStarted.stdout).mission;
    const humanTick = runCli(['mission', 'tick', humanMission.id, '--verify', '--json'], { cwd: dir });
    assert.equal(humanTick.status, 0, humanTick.stderr || humanTick.stdout);
    const humanReceiptPath = JSON.parse(humanTick.stdout).receipt_path;

    const humanCompleted = runCli(['mission', 'complete', humanMission.id, '--proof', humanReceiptPath], { cwd: dir });
    assert.equal(humanCompleted.status, 0, humanCompleted.stderr || humanCompleted.stdout);
    assert.match(humanCompleted.stdout, /Landing:/);
    assert.match(humanCompleted.stdout, /Changed: human complete receipt mission is complete\./);
    assert.match(humanCompleted.stdout, /Artifact: Open timeline at atris\/runs\/mission-/);
    assert.match(humanCompleted.stdout, /How I checked: I checked the passing verifier receipt/);
    assert.match(humanCompleted.stdout, /What I tested: Verifier passed: node -e "process\.exit\(0\)"/);
    assert.match(humanCompleted.stdout, /Proof: Proof saved at/);
    assert.match(humanCompleted.stdout, /Next: Pick the next customer-facing move\./);
    assert.doesNotMatch(humanCompleted.stdout, /AgentXP:/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('mission complete credits ad hoc passing receipt before no-verifier fallback', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const started = runCli([
      'mission',
      'start',
      'ad hoc verifier completion receipt',
      '--owner',
      'mission-lead',
      '--json',
    ], { cwd: dir });
    assert.equal(started.status, 0, started.stderr || started.stdout);
    const mission = JSON.parse(started.stdout).mission;

    const tick = runCli([
      'mission',
      'tick',
      mission.id,
      '--verify',
      'node -e "process.exit(0)"',
      '--summary',
      'Proved with an ad hoc verifier.',
      '--json',
    ], { cwd: dir });
    assert.equal(tick.status, 0, tick.stderr || tick.stdout);
    const receiptPath = JSON.parse(tick.stdout).receipt_path;

    const completed = runCli(['mission', 'complete', mission.id, '--proof', receiptPath, '--json'], { cwd: dir });
    assert.equal(completed.status, 0, completed.stderr || completed.stdout);
    const payload = JSON.parse(completed.stdout);
    assert.equal(payload.mission.completion_gate.source, 'receipt');
    assert.match(payload.landing.checked, /passing verifier receipt/);
    assert.doesNotMatch(payload.landing.checked, /No verifier was configured/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('mission run objective starts with product takeoff instead of runner plumbing', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const started = runCli([
      'mission',
      'run',
      'human started takeoff',
      '--owner',
      'mission-lead',
      '--runner',
      'codex_goal',
      '--verify',
      'node -e "process.exit(0)"',
    ], { cwd: dir });
    assert.equal(started.status, 0, started.stderr || started.stdout);
    assert.match(started.stdout, /^Takeoff:/m);
    assert.match(started.stdout, /Goal: human started takeoff/);
    assert.match(started.stdout, /Done when: verifier passes and visible goal lands\./);
    assert.match(started.stdout, /Proof: Mission state saved in \.atris\/state\/missions\.jsonl\./);
    assert.match(started.stdout, /Check: Verifier configured: node -e "process\.exit\(0\)"/);
    assert.match(started.stdout, /Next: Start the visible goal, then continue this mission\./);
    assert.doesNotMatch(started.stdout, /^(Started mission|Owner|Runner|Atris goal|Codex goal):/m);
    assert.doesNotMatch(started.stdout, /^Landing:/m);
  } finally {
    cleanupTempDir(dir);
  }
});

test('mission run summary starts with product landing instead of run internals', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const started = runCli([
      'mission',
      'start',
      'human run summary landing',
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
    ], { cwd: dir });
    assert.equal(ack.status, 0, ack.stderr || ack.stdout);

    const ran = runCli(['mission', 'run', mission.id, '--max-ticks', '1'], { cwd: dir });
    assert.equal(ran.status, 0, ran.stderr || ran.stdout);
    assert.match(ran.stdout, /^Landing:/m);
    assert.match(ran.stdout, /Changed: human run summary landing is ready for review\./);
    assert.match(ran.stdout, /How I checked: Verifier passed: node -e "process\.exit\(0\)"/);
    assert.match(ran.stdout, /Proof: Summary receipt saved at atris\/runs\/mission-/);
    assert.match(ran.stdout, new RegExp(`Timeline: atris mission timeline ${mission.id} --limit 5`));
    assert.match(ran.stdout, new RegExp(`Export: atris mission timeline ${mission.id} --all --write`));
    assert.match(ran.stdout, new RegExp(`Prune preview: atris mission timeline ${mission.id} --prune-preview`));
    assert.match(ran.stdout, /Next: Review the proof, then complete the mission\./);
    assert.doesNotMatch(ran.stdout, /^(Ran mission|  objective|  ran_ticks|  final state|  session|  summary receipt):/m);
  } finally {
    cleanupTempDir(dir);
  }
});

test('mission tick landing uses step summary when provided', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const started = runCli([
      'mission',
      'start',
      'overnight self improve loop',
      '--owner',
      'mission-lead',
      '--verify',
      'node -e "process.exit(0)"',
      '--json',
    ], { cwd: dir });
    assert.equal(started.status, 0, started.stderr || started.stdout);
    const mission = JSON.parse(started.stdout).mission;

    const ticked = runCli([
      'mission',
      'tick',
      mission.id,
      '--verify',
      '--summary',
      'Made review landing proof high-level.',
    ], { cwd: dir });
    assert.equal(ticked.status, 0, ticked.stderr || ticked.stdout);
    assert.match(ticked.stdout, /^Landing:/m);
    assert.match(ticked.stdout, /Changed: Made review landing proof high-level\./);
    assert.doesNotMatch(ticked.stdout, /Changed: overnight self improve loop is ready for review\./);
    assert.match(ticked.stdout, /How I checked: Verifier passed: node -e "process\.exit\(0\)"/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('mission tick receipt stores result.landing with high-level verifier meaning', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'smoke.test.js'), [
      "const test = require('node:test');",
      "const assert = require('node:assert/strict');",
      "test('smoke behavior', () => assert.equal(1 + 1, 2));",
      '',
    ].join('\n'), 'utf8');
    const started = runCli([
      'mission',
      'start',
      'standard landing receipt mission',
      '--owner',
      'mission-lead',
      '--verify',
      'node --test smoke.test.js',
      '--json',
    ], { cwd: dir });
    assert.equal(started.status, 0, started.stderr || started.stdout);
    const mission = JSON.parse(started.stdout).mission;

    const ticked = runCli([
      'mission',
      'tick',
      mission.id,
      '--verify',
      '--summary',
      'Standardized mission proof receipts.',
      '--json',
    ], { cwd: dir });
    assert.equal(ticked.status, 0, ticked.stderr || ticked.stdout);
    const payload = JSON.parse(ticked.stdout);
    const receipt = JSON.parse(fs.readFileSync(path.join(dir, payload.receipt_path), 'utf8'));

    assert.equal(receipt.result.landing.schema, 'atris.result_landing.v1');
    assert.equal(receipt.result.landing.changed, 'Standardized mission proof receipts.');
    assert.equal(receipt.result.landing.checked, 'I ran the behavior checks.');
    assert.match(receipt.result.landing.tested, /Automated behavior checks passed/);
    assert.match(receipt.result.landing.proof, /Receipt saved at atris\/runs\/mission-/);
    assert.match(receipt.result.landing.next, /Review the proof, then complete the mission/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('mission timeline reads standard result.landing from tick receipts', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const started = runCli([
      'mission',
      'start',
      'timeline standard landing receipt',
      '--owner',
      'mission-lead',
      '--json',
    ], { cwd: dir });
    assert.equal(started.status, 0, started.stderr || started.stdout);
    const mission = JSON.parse(started.stdout).mission;

    const ticked = runCli([
      'mission',
      'tick',
      mission.id,
      '--summary',
      'Saved a human-readable landing receipt.',
      '--json',
    ], { cwd: dir });
    assert.equal(ticked.status, 0, ticked.stderr || ticked.stdout);

    const timeline = runCli(['mission', 'timeline', mission.id, '--json'], { cwd: dir });
    assert.equal(timeline.status, 0, timeline.stderr || timeline.stdout);
    const payload = JSON.parse(timeline.stdout);
    assert.equal(payload.current_landing.changed, 'Saved a human-readable landing receipt.');
    assert.match(payload.current_landing.next, /Keep running the mission/);
    assert.equal(payload.current_landing.receipt_path, JSON.parse(ticked.stdout).receipt_path);
  } finally {
    cleanupTempDir(dir);
  }
});

test('mission tick landing describes common verifier checks plainly', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const gitInit = spawnSync('git', ['init'], { cwd: dir, encoding: 'utf8' });
    if (gitInit.status !== 0) return;
    const started = runCli([
      'mission',
      'start',
      'plain verifier wording',
      '--owner',
      'mission-lead',
      '--verify',
      'git diff --check',
      '--json',
    ], { cwd: dir });
    assert.equal(started.status, 0, started.stderr || started.stdout);
    const mission = JSON.parse(started.stdout).mission;

    const ticked = runCli([
      'mission',
      'tick',
      mission.id,
      '--verify',
      '--summary',
      'Recorded a clean proof step.',
    ], { cwd: dir });
    assert.equal(ticked.status, 0, ticked.stderr || ticked.stdout);
    assert.match(ticked.stdout, /Changed: Recorded a clean proof step\./);
    assert.match(ticked.stdout, /How I checked: I ran the diff cleanliness check\./);
    assert.doesNotMatch(ticked.stdout, /How I checked: Verifier passed: git diff --check/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('mission report keeps worker debrief separate from verifier proof', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const receiptPath = path.join('atris', 'runs', 'mission-atris2-ready.json');
    fs.mkdirSync(path.join(dir, 'atris', 'runs'), { recursive: true });
    fs.writeFileSync(path.join(dir, receiptPath), JSON.stringify({
      schema: 'atris.mission_receipt.v1',
      mission_id: 'mission-atris2-ready',
      objective: 'remote worker proof',
      owner: 'mission-lead',
      at: '2026-06-26T12:00:00.000Z',
      verifier: 'true',
      result: {
        kind: 'mission_run_tick',
        tick: {
          status: 'ran',
          reason: 'tick-ok',
          atris2: {
            ok: true,
            engine: 'atris2',
            tools_run: ['local_file_op'],
            receipt_text: 'ATRIS2_MISSION_WORKER_READY\nRemote worker ran tools and returned a useful receipt.',
          },
        },
        verifier_result: { passed: true, command: 'true', status: 0 },
      },
    }, null, 2), 'utf8');
    appendMissionState(dir, {
      id: 'mission-atris2-ready',
      slug: 'mission-atris2-ready',
      objective: 'remote worker proof',
      runner: 'atris2',
      model: 'atris:fast',
      status: 'ready',
      verifier: 'true',
      verifier_result: { passed: true, command: 'true', status: 0 },
      receipt_path: receiptPath,
      next_action: 'review proof then complete mission',
      created_at: '2026-06-26T12:00:00.000Z',
      updated_at: '2026-06-26T12:01:00.000Z',
    });

    const report = runCli(['mission', 'report', '--limit', '1'], { cwd: dir });
    assert.equal(report.status, 0, report.stderr || report.stdout);
    assert.match(report.stdout, /What happened: Verifier passed\./);
    assert.match(report.stdout, /Worker: Remote Atris2 computer using atris:fast/);
    assert.match(report.stdout, /Worker summary: ATRIS2_MISSION_WORKER_READY/);
    assert.match(report.stdout, /Worker receipt: atris\/runs\/mission-atris2-ready\.json/);
    assert.match(report.stdout, /Verifier receipt: atris\/runs\/mission-atris2-ready\.json/);
    assert.doesNotMatch(report.stdout, /atris mission - durable goal/);

    const json = runCli(['mission', 'report', 'mission-atris2-ready', '--json'], { cwd: dir });
    assert.equal(json.status, 0, json.stderr || json.stdout);
    const payload = JSON.parse(json.stdout);
    assert.equal(payload.action, 'mission_report');
    assert.equal(payload.reports[0].worker, 'Remote Atris2 computer using atris:fast');
    assert.equal(payload.reports[0].operator_next, 'review proof then complete mission');
  } finally {
    cleanupTempDir(dir);
  }
});

test('mission report shows compact chronological receipt timeline', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const started = runCli([
      'mission',
      'start',
      'timeline proof mission',
      '--owner',
      'mission-lead',
      '--json',
    ], { cwd: dir });
    assert.equal(started.status, 0, started.stderr || started.stdout);
    const mission = JSON.parse(started.stdout).mission;

    const firstTick = runCli([
      'mission',
      'tick',
      mission.id,
      '--summary',
      'First goal done - built the owner route',
      '--json',
    ], { cwd: dir });
    assert.equal(firstTick.status, 0, firstTick.stderr || firstTick.stdout);

    const secondTick = runCli([
      'mission',
      'tick',
      mission.id,
      '--summary',
      'Next goal done - made proof readable',
      '--json',
    ], { cwd: dir });
    assert.equal(secondTick.status, 0, secondTick.stderr || secondTick.stdout);

    const report = runCli(['mission', 'report', mission.id], { cwd: dir });
    assert.equal(report.status, 0, report.stderr || report.stdout);
    assert.match(report.stdout, /Timeline:/);
    assert.match(report.stdout, /Goal 1: First goal done - built the owner route/);
    assert.match(report.stdout, /Goal 2: Next goal done - made proof readable/);
    assert.ok(
      report.stdout.indexOf('Goal 1: First goal done - built the owner route')
        < report.stdout.indexOf('Goal 2: Next goal done - made proof readable'),
      report.stdout,
    );

    const json = runCli(['mission', 'report', mission.id, '--json'], { cwd: dir });
    assert.equal(json.status, 0, json.stderr || json.stdout);
    const payload = JSON.parse(json.stdout);
    const timeline = payload.reports[0].timeline;
    assert.equal(timeline.length, 2);
    assert.equal(timeline[0].tick_index, 1);
    assert.equal(timeline[1].tick_index, 2);
    assert.match(timeline[0].title, /First goal done - built the owner route/);
    assert.match(timeline[1].title, /Next goal done - made proof readable/);
    assert.match(timeline[0].receipt_path, /^atris\/runs\/mission-/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('mission timeline lists saved landing changed and next lines', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris', 'reports'), { recursive: true });
    const noMissionJson = runCli(['mission', 'timeline', '--json'], { cwd: dir });
    assert.equal(noMissionJson.status, 0, noMissionJson.stderr || noMissionJson.stdout);
    const noMissionPayload = JSON.parse(noMissionJson.stdout);
    assert.deepEqual(noMissionPayload.empty_state_display, {
      label: 'Empty state',
      is_empty: true,
      has_mission: false,
      title: 'No missions yet.',
      message: 'Start a mission to create the first timeline item.',
      action_label: 'Start mission',
      command: 'atris mission start "..." --owner <member>',
    });
    fs.writeFileSync(path.join(dir, 'atris', 'reports', '2099-01-01-proof.md'), [
      '# Proof',
      '',
      'Suggested target: add receipt timeline proof.',
      '',
    ].join('\n'), 'utf8');
    appendMissionState(dir, {
      id: 'landing-timeline-codex-loop',
      slug: 'landing-timeline-codex-loop',
      objective: 'landing timeline codex loop',
      status: 'ready',
      runner: 'codex_goal',
      verifier: 'node -e "process.exit(0)"',
      always_on: true,
      cadence: '13m',
      xp_task_enabled: false,
      native_goal_ack: {
        runtime: 'codex',
        status: 'active',
        objective: 'landing timeline codex loop',
        acknowledged_at: '2026-05-02T00:01:00.000Z',
      },
      created_at: '2026-05-02T00:00:00.000Z',
      updated_at: '2026-05-02T00:00:00.000Z',
    });

    const emptyMissionJson = runCli(['mission', 'timeline', 'landing-timeline-codex-loop', '--json'], { cwd: dir });
    assert.equal(emptyMissionJson.status, 0, emptyMissionJson.stderr || emptyMissionJson.stdout);
    const emptyMissionPayload = JSON.parse(emptyMissionJson.stdout);
    assert.equal(emptyMissionPayload.timeline.length, 0);
    assert.deepEqual(emptyMissionPayload.empty_state_display, {
      label: 'Empty state',
      is_empty: true,
      has_mission: true,
      title: 'No timeline items yet.',
      message: 'Run the mission once to create the first timeline item.',
      action_label: 'Run mission',
      command: 'atris mission run landing-timeline-codex-loop --create-next',
    });

    const run = runCli(['mission', 'run', 'landing-timeline-codex-loop', '--no-drain', '--create-next'], { cwd: dir });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    assert.match(run.stdout, /Changed: Created and claimed next task:/);

    const timeline = runCli(['mission', 'timeline', 'landing-timeline-codex-loop'], { cwd: dir });
    assert.equal(timeline.status, 0, timeline.stderr || timeline.stdout);
    assert.match(timeline.stdout, /Mission timeline: landing timeline codex loop/);
    assert.match(timeline.stdout, /Generated at: \d{4}-\d{2}-\d{2}T/);
    assert.match(timeline.stdout, /Showing 1 item\./);
    assert.match(timeline.stdout, /Current landing:\n  Changed: Created and claimed next task: \S+ Add receipt timeline proof\./);
    assert.doesNotMatch(timeline.stdout, /History:/);
    assert.doesNotMatch(timeline.stdout, /landing timeline codex loop recorded tick 1\./);
    assert.doesNotMatch(timeline.stdout, /  1\. Created and claimed next task/);
    assert.match(timeline.stdout, /Created and claimed next task: \S+ Add receipt timeline proof\./);
    assert.match(timeline.stdout, /Next: Created next task: \S+ Add receipt timeline proof\./);
    assert.match(timeline.stdout, /Proof: atris\/runs\/mission-/);
    assert.doesNotMatch(timeline.stdout, /Full history:/);

    const json = runCli(['mission', 'timeline', 'landing-timeline-codex-loop', '--json'], { cwd: dir });
    assert.equal(json.status, 0, json.stderr || json.stdout);
    const payload = JSON.parse(json.stdout);
    assert.equal(payload.action, 'mission_timeline');
    assert.match(payload.generated_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(payload.generated, {
      label: 'Generated at',
      at: payload.generated_at,
    });
    assert.deepEqual(payload.schema_display, {
      label: 'Schema',
      name: 'atris.mission_timeline',
      version: 1,
      primary_objects: [
        'display',
        'summary_display',
        'navigation_display',
        'filter_display',
        'mission_display',
        'current_landing_display',
        'history_without_current_display',
        'timeline_display',
        'timeline_meta_display',
        'empty_state_display',
        'status_display',
        'actions_display',
        'proof_display',
        'receipt_display',
        'export_display',
        'prune_display',
        'artifact_display',
      ],
    });
    for (const objectName of payload.schema_display.primary_objects) {
      assert.ok(Object.hasOwn(payload, objectName), objectName);
    }
    assert.deepEqual(payload.summary_display, {
      label: 'Summary',
      title: 'Mission timeline: landing timeline codex loop',
      count: 'Showing 1 item.',
      latest_label: 'Latest',
      latest: payload.current_landing.changed,
      proof_label: 'Proof',
      proof: payload.current_landing.receipt_path,
      next_label: 'Next',
      next: payload.next_move,
    });
    assert.deepEqual(payload.display, {
      title: 'Mission timeline: landing timeline codex loop',
      generated: `Generated at: ${payload.generated_at}`,
      count: 'Showing 1 item.',
      current_landing_label: 'Current landing',
      history_label: 'History',
      next_label: 'Next',
    });
    assert.deepEqual(payload.status_display, {
      label: 'Status',
      mission_status_label: 'Mission status',
      mission_status: payload.mission.status,
      history_status_label: 'History status',
      history_status: 'Full history',
      count: 'Showing 1 item.',
      truncated: false,
      hidden_count: 0,
    });
    assert.equal(payload.mission.id, 'landing-timeline-codex-loop');
    assert.deepEqual(payload.mission_labels, {
      mission: 'Mission',
      objective: 'Objective',
      status: 'Status',
    });
    assert.deepEqual(payload.mission_display, {
      label: 'Mission',
      title: payload.mission.objective,
      id: payload.mission.id,
      status: payload.mission.status,
    });
    assert.deepEqual(payload.operator_commands, {
      timeline: 'atris mission timeline landing-timeline-codex-loop --limit 5',
      export: 'atris mission timeline landing-timeline-codex-loop --all --write',
      prune_preview: 'atris mission timeline landing-timeline-codex-loop --prune-preview',
    });
    assert.deepEqual(payload.commands, payload.operator_commands);
    assert.deepEqual(payload.actions_display, {
      label: 'Actions',
      items: [
        { label: 'Timeline', command: payload.commands.timeline },
        { label: 'Export', command: payload.commands.export },
        { label: 'Prune preview', command: payload.commands.prune_preview },
      ],
    });
    assert.deepEqual(payload.navigation_display, {
      label: 'Navigation',
      current_label: 'Current view',
      current: 'timeline',
      items: [
        { key: 'timeline', label: 'Timeline', command: payload.commands.timeline, active: true },
        { key: 'export', label: 'Full history', command: payload.commands.export, active: false },
        { key: 'prune_preview', label: 'Prune preview', command: payload.commands.prune_preview, active: false },
      ],
    });
    assert.deepEqual(payload.filter_display, {
      label: 'Filters',
      active_label: 'Active filter',
      active: 'latest',
      limit_label: 'Limit',
      limit: payload.timeline_meta.limit,
      shown_count: payload.timeline_meta.shown_count,
      total_count: payload.timeline_meta.total_count,
      hidden_count: payload.timeline_meta.hidden_count,
      truncated_label: 'Truncated',
      truncated: payload.timeline_meta.truncated,
      items: [
        { key: 'latest', label: 'Latest', command: payload.commands.timeline, active: true },
        { key: 'full_history', label: 'Full history', command: 'atris mission timeline landing-timeline-codex-loop --all', active: false },
      ],
    });
    assert.deepEqual(payload.receipt_display, {
      label: 'Receipts',
      latest_label: 'Latest receipt',
      latest_path: payload.current_landing.receipt_path,
      has_latest: true,
      count_label: 'Receipts',
      count: 1,
      items: [{
        index: 1,
        label: 'Receipt 1',
        path: payload.timeline[0].receipt_path,
        at: payload.timeline[0].at,
        current: true,
      }],
    });
    assert.equal(payload.timeline.length, 1);
    assert.deepEqual(payload.timeline_meta, {
      shown_count: 1,
      total_count: 1,
      hidden_count: 0,
      truncated: false,
      limit: 12,
    });
    assert.deepEqual(payload.empty_state_display, {
      label: 'Empty state',
      is_empty: false,
      has_mission: true,
      title: null,
      message: null,
      action_label: null,
      command: null,
    });
    assert.deepEqual(payload.timeline_meta_display, {
      label: 'Timeline metadata',
      shown_label: 'Shown',
      shown_count: 1,
      total_label: 'Total',
      total_count: 1,
      hidden_label: 'Hidden',
      hidden_count: 0,
      limit_label: 'Limit',
      limit: 12,
      truncated_label: 'Truncated',
      truncated: false,
    });
    assert.deepEqual(payload.timeline_display, [{
      index: 1,
      label: 'Timeline item 1',
      at_label: 'When',
      at: payload.timeline[0].at,
      changed_label: 'Changed',
      changed: payload.timeline[0].changed,
      next_label: 'Next',
      next: payload.timeline[0].next,
      proof_label: 'Proof',
      proof: payload.timeline[0].receipt_path,
    }]);
    assert.match(payload.next_move, /Created next task: \S+ Add receipt timeline proof\./);
    assert.deepEqual(payload.next, {
      label: 'Next',
      move: payload.next_move,
      has_move: true,
    });
    assert.deepEqual(payload.current_landing, {
      at: payload.timeline[0].at,
      changed: payload.timeline[0].changed,
      next: payload.timeline[0].next,
      receipt_path: payload.timeline[0].receipt_path,
    });
    assert.deepEqual(payload.current_landing_display, {
      label: 'Current landing',
      changed_label: 'Changed',
      changed: payload.current_landing.changed,
      next_label: 'Next',
      next: payload.current_landing.next,
      proof_label: 'Proof',
      proof: payload.current_landing.receipt_path,
    });
    assert.equal(payload.current_landing_label, 'Current landing');
    assert.deepEqual(payload.history_without_current, []);
    assert.deepEqual(payload.history_without_current_display, []);
    assert.equal(payload.history_without_current_count, 0);
    assert.equal(payload.has_history_without_current, false);
    assert.equal(payload.history_label, 'History');
    assert.deepEqual(payload.labels, {
      current_landing: 'Current landing',
      history: 'History',
    });
    assert.deepEqual(payload.counts, {
      timeline: 1,
      history_without_current: 0,
      total: 1,
      hidden: 0,
      shown: 1,
    });
    assert.deepEqual(payload.booleans, {
      has_current_landing: true,
      has_history_without_current: false,
      truncated: false,
      all: false,
    });
    assert.deepEqual(payload.artifact, {
      path: null,
      written: false,
      format: null,
    });
    assert.deepEqual(payload.artifact_display, {
      label: 'Artifact',
      path_label: 'Path',
      path: null,
      written_label: 'Written',
      written: false,
      format_label: 'Format',
      format: null,
    });
    assert.deepEqual(payload.export_display, {
      label: 'Export',
      command: payload.commands.export,
      report_label: 'Saved report',
      report_path: null,
      report_written: false,
      report_format: null,
    });
    assert.deepEqual(payload.prune_display, {
      label: 'Prune preview',
      command: payload.commands.prune_preview,
      available: false,
      ok: null,
      summary: null,
      would_prune_label: 'Would prune',
      prune_count: null,
      prune_bytes_text: null,
      deleted_label: 'Deleted',
      deleted_count: null,
    });
    assert.deepEqual(payload.proof_display, {
      label: 'Proof',
      latest_receipt_label: 'Latest receipt',
      latest_receipt_path: payload.current_landing.receipt_path,
      report_label: 'Saved report',
      report_path: null,
      report_written: false,
      report_format: null,
    });
    assert.match(payload.timeline[0].changed, /Created and claimed next task:/);
    assert.match(payload.timeline[0].next, /Created next task:/);
    assert.match(payload.timeline[0].receipt_path, /^atris\/runs\/mission-/);

    const secondRun = runCli(['mission', 'run', 'landing-timeline-codex-loop', '--no-drain', '--create-next'], { cwd: dir });
    assert.equal(secondRun.status, 0, secondRun.stderr || secondRun.stdout);
    assert.match(secondRun.stdout, /Changed: Kept active task:/);

    const limitedText = runCli(['mission', 'timeline', 'landing-timeline-codex-loop', '--limit', '1'], { cwd: dir });
    assert.equal(limitedText.status, 0, limitedText.stderr || limitedText.stdout);
    assert.match(limitedText.stdout, /Showing latest 1 of 2 items\./);
    assert.doesNotMatch(limitedText.stdout, /History:/);
    assert.doesNotMatch(limitedText.stdout, /  1\. Kept active task/);
    assert.match(limitedText.stdout, /Full history: atris mission timeline landing-timeline-codex-loop --all --write/);

    const limited = runCli(['mission', 'timeline', 'landing-timeline-codex-loop', '--limit', '1', '--json'], { cwd: dir });
    assert.equal(limited.status, 0, limited.stderr || limited.stdout);
    const limitedPayload = JSON.parse(limited.stdout);
    assert.equal(limitedPayload.timeline.length, 1);
    assert.deepEqual(limitedPayload.history_without_current, []);
    assert.deepEqual(limitedPayload.history_without_current_display, []);
    assert.equal(limitedPayload.history_without_current_count, 0);
    assert.equal(limitedPayload.has_history_without_current, false);
    assert.equal(limitedPayload.history_label, 'History');
    assert.deepEqual(limitedPayload.labels, {
      current_landing: 'Current landing',
      history: 'History',
    });
    assert.deepEqual(limitedPayload.counts, {
      timeline: 1,
      history_without_current: 0,
      total: 2,
      hidden: 1,
      shown: 1,
    });
    assert.deepEqual(limitedPayload.booleans, {
      has_current_landing: true,
      has_history_without_current: false,
      truncated: true,
      all: false,
    });
    assert.deepEqual(limitedPayload.timeline_meta, {
      shown_count: 1,
      total_count: 2,
      hidden_count: 1,
      truncated: true,
      limit: 1,
    });
    assert.deepEqual(limitedPayload.timeline_meta_display, {
      label: 'Timeline metadata',
      shown_label: 'Shown',
      shown_count: 1,
      total_label: 'Total',
      total_count: 2,
      hidden_label: 'Hidden',
      hidden_count: 1,
      limit_label: 'Limit',
      limit: 1,
      truncated_label: 'Truncated',
      truncated: true,
    });
    assert.deepEqual(limitedPayload.status_display, {
      label: 'Status',
      mission_status_label: 'Mission status',
      mission_status: limitedPayload.mission.status,
      history_status_label: 'History status',
      history_status: 'Compact history',
      count: 'Showing latest 1 of 2 items.',
      truncated: true,
      hidden_count: 1,
    });

    const allJson = runCli(['mission', 'timeline', 'landing-timeline-codex-loop', '--limit', '1', '--all', '--json'], { cwd: dir });
    assert.equal(allJson.status, 0, allJson.stderr || allJson.stdout);
    const allPayload = JSON.parse(allJson.stdout);
    assert.equal(allPayload.all, true);
    assert.equal(allPayload.timeline.length, 2);
    assert.deepEqual(allPayload.timeline_display, allPayload.timeline.map((item, index) => ({
      index: index + 1,
      label: `Timeline item ${index + 1}`,
      at_label: 'When',
      at: item.at,
      changed_label: 'Changed',
      changed: item.changed,
      next_label: 'Next',
      next: item.next,
      proof_label: 'Proof',
      proof: item.receipt_path,
    })));
    assert.deepEqual(allPayload.history_without_current, [allPayload.timeline[0]]);
    assert.deepEqual(allPayload.history_without_current_display, [{
      index: 1,
      label: 'History item 1',
      changed_label: 'Changed',
      changed: allPayload.history_without_current[0].changed,
      next_label: 'Next',
      next: allPayload.history_without_current[0].next,
      proof_label: 'Proof',
      proof: allPayload.history_without_current[0].receipt_path,
    }]);
    assert.equal(allPayload.history_without_current_count, 1);
    assert.equal(allPayload.has_history_without_current, true);
    assert.equal(allPayload.history_label, 'History');
    assert.deepEqual(allPayload.labels, {
      current_landing: 'Current landing',
      history: 'History',
    });
    assert.deepEqual(allPayload.counts, {
      timeline: 2,
      history_without_current: 1,
      total: 2,
      hidden: 0,
      shown: 2,
    });
    assert.deepEqual(allPayload.booleans, {
      has_current_landing: true,
      has_history_without_current: true,
      truncated: false,
      all: true,
    });
    assert.deepEqual(allPayload.timeline_meta, {
      shown_count: 2,
      total_count: 2,
      hidden_count: 0,
      truncated: false,
      limit: null,
    });
    assert.deepEqual(allPayload.timeline_meta_display, {
      label: 'Timeline metadata',
      shown_label: 'Shown',
      shown_count: 2,
      total_label: 'Total',
      total_count: 2,
      hidden_label: 'Hidden',
      hidden_count: 0,
      limit_label: 'Limit',
      limit: null,
      truncated_label: 'Truncated',
      truncated: false,
    });
    assert.match(allPayload.next_move, /Continue active task: \S+ Add receipt timeline proof\./);
    assert.deepEqual(allPayload.current_landing, {
      at: allPayload.timeline[1].at,
      changed: allPayload.timeline[1].changed,
      next: allPayload.timeline[1].next,
      receipt_path: allPayload.timeline[1].receipt_path,
    });
    assert.deepEqual(allPayload.current_landing_display, {
      label: 'Current landing',
      changed_label: 'Changed',
      changed: allPayload.current_landing.changed,
      next_label: 'Next',
      next: allPayload.current_landing.next,
      proof_label: 'Proof',
      proof: allPayload.current_landing.receipt_path,
    });
    assert.equal(allPayload.current_landing_label, 'Current landing');

    const preview = runCli(['mission', 'timeline', 'landing-timeline-codex-loop', '--prune-preview'], { cwd: dir });
    assert.equal(preview.status, 0, preview.stderr || preview.stdout);
    assert.match(preview.stdout, /Prune dry-run: \d+ files \/ [^)]+ would prune; \d+ deleted\./);
    assert.doesNotMatch(preview.stdout, /Saved:/);

    const previewJson = runCli(['mission', 'timeline', 'landing-timeline-codex-loop', '--prune-preview', '--json'], { cwd: dir });
    assert.equal(previewJson.status, 0, previewJson.stderr || previewJson.stdout);
    const previewPayload = JSON.parse(previewJson.stdout);
    assert.equal(previewPayload.artifact_path, null);
    assert.deepEqual(previewPayload.artifact, {
      path: null,
      written: false,
      format: null,
    });
    assert.equal(previewPayload.prune_summary?.ok, true);
    assert.match(previewPayload.prune_summary?.text, /Prune dry-run: \d+ files \/ [^)]+ would prune; \d+ deleted\./);
    assert.deepEqual(previewPayload.prune_display, {
      label: 'Prune preview',
      command: previewPayload.commands.prune_preview,
      available: true,
      ok: true,
      summary: previewPayload.prune_summary.text,
      would_prune_label: 'Would prune',
      prune_count: previewPayload.prune_summary.prune_count,
      prune_bytes_text: previewPayload.prune_summary.prune_bytes_text,
      deleted_label: 'Deleted',
      deleted_count: previewPayload.prune_summary.deleted_count,
    });

    const written = runCli(['mission', 'timeline', 'landing-timeline-codex-loop', '--all', '--write'], { cwd: dir });
    assert.equal(written.status, 0, written.stderr || written.stdout);
    assert.match(written.stdout, /Generated at: \d{4}-\d{2}-\d{2}T/);
    assert.match(written.stdout, /Showing 2 items\./);
    assert.doesNotMatch(written.stdout, /Full history:/);
    assert.match(written.stdout, /Saved: atris\/reports\/landing-timeline-codex-loop-timeline\.md/);
    assert.match(written.stdout, /Prune dry-run: \d+ files \/ [^)]+ would prune; \d+ deleted\./);
    const markdown = fs.readFileSync(path.join(dir, 'atris', 'reports', 'landing-timeline-codex-loop-timeline.md'), 'utf8');
    assert.match(markdown, /# Mission timeline: landing timeline codex loop/);
    assert.match(markdown, /Generated at: \d{4}-\d{2}-\d{2}T/);
    assert.match(markdown, /Showing 2 items\./);
    assert.match(markdown, /1\. Created and claimed next task: \S+ Add receipt timeline proof\./);
    assert.match(markdown, /2\. Kept active task: \S+ Add receipt timeline proof\. No duplicate was created\./);
    assert.match(markdown, /- Next: Created next task: \S+ Add receipt timeline proof\./);
    assert.match(markdown, /- Proof: atris\/runs\/mission-/);
    assert.match(markdown, /## Operator commands/);
    assert.match(markdown, /- Timeline: `atris mission timeline landing-timeline-codex-loop --limit 5`/);
    assert.match(markdown, /- Export: `atris mission timeline landing-timeline-codex-loop --all --write`/);
    assert.match(markdown, /- Prune preview: `atris mission timeline landing-timeline-codex-loop --prune-preview`/);
    assert.ok(markdown.indexOf('## Operator commands') < markdown.indexOf('1. Created and claimed next task'), markdown);
    assert.match(markdown, /## Current landing/);
    assert.match(markdown, /Changed: Kept active task: \S+ Add receipt timeline proof\. No duplicate was created\./);
    assert.match(markdown, /Next: Continue active task: \S+ Add receipt timeline proof\./);
    assert.ok(markdown.indexOf('## Current landing') < markdown.indexOf('1. Created and claimed next task'), markdown);
    assert.match(markdown, /## Full history/);
    assert.ok(markdown.indexOf('## Current landing') < markdown.indexOf('## Full history'), markdown);
    assert.ok(markdown.indexOf('## Full history') < markdown.indexOf('1. Created and claimed next task'), markdown);
    assert.match(markdown, /## Next move\n\nContinue active task: \S+ Add receipt timeline proof\./);
    assert.match(markdown, /## Keep it concise/);
    assert.match(markdown, /Dry run: `atris mission prune-runs --days 14 --keep-newest 200`/);
    assert.match(markdown, /Apply only after review: add `--apply`\./);
    assert.match(markdown, /## Latest prune dry-run/);
    assert.match(markdown, /Policy: keep newest 200; keep 14 days/);
    assert.match(markdown, /Total run files: \d+/);
    assert.match(markdown, /Would prune: \d+ files \/ [\d,]+ bytes \([^)]+\)/);

    const writtenJson = runCli(['mission', 'timeline', 'landing-timeline-codex-loop', '--all', '--write', '--json'], { cwd: dir });
    assert.equal(writtenJson.status, 0, writtenJson.stderr || writtenJson.stdout);
    const writtenPayload = JSON.parse(writtenJson.stdout);
    assert.match(writtenPayload.generated_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(writtenPayload.generated, {
      label: 'Generated at',
      at: writtenPayload.generated_at,
    });
    assert.deepEqual(writtenPayload.schema_display, payload.schema_display);
    assert.deepEqual(writtenPayload.summary_display, {
      label: 'Summary',
      title: 'Mission timeline: landing timeline codex loop',
      count: 'Showing 2 items.',
      latest_label: 'Latest',
      latest: writtenPayload.current_landing.changed,
      proof_label: 'Proof',
      proof: writtenPayload.current_landing.receipt_path,
      next_label: 'Next',
      next: writtenPayload.next_move,
    });
    assert.deepEqual(writtenPayload.display, {
      title: 'Mission timeline: landing timeline codex loop',
      generated: `Generated at: ${writtenPayload.generated_at}`,
      count: 'Showing 2 items.',
      current_landing_label: 'Current landing',
      history_label: 'History',
      next_label: 'Next',
    });
    assert.deepEqual(writtenPayload.mission_labels, {
      mission: 'Mission',
      objective: 'Objective',
      status: 'Status',
    });
    assert.deepEqual(writtenPayload.mission_display, {
      label: 'Mission',
      title: writtenPayload.mission.objective,
      id: writtenPayload.mission.id,
      status: writtenPayload.mission.status,
    });
    assert.match(writtenPayload.next_move, /Continue active task: \S+ Add receipt timeline proof\./);
    assert.deepEqual(writtenPayload.next, {
      label: 'Next',
      move: writtenPayload.next_move,
      has_move: true,
    });
    assert.equal(writtenPayload.operator_commands.export, 'atris mission timeline landing-timeline-codex-loop --all --write');
    assert.deepEqual(writtenPayload.actions_display, {
      label: 'Actions',
      items: [
        { label: 'Timeline', command: writtenPayload.commands.timeline },
        { label: 'Export', command: writtenPayload.commands.export },
        { label: 'Prune preview', command: writtenPayload.commands.prune_preview },
      ],
    });
    assert.deepEqual(writtenPayload.navigation_display, {
      label: 'Navigation',
      current_label: 'Current view',
      current: 'timeline',
      items: [
        { key: 'timeline', label: 'Timeline', command: writtenPayload.commands.timeline, active: true },
        { key: 'export', label: 'Full history', command: writtenPayload.commands.export, active: false },
        { key: 'prune_preview', label: 'Prune preview', command: writtenPayload.commands.prune_preview, active: false },
      ],
    });
    assert.deepEqual(writtenPayload.filter_display, {
      label: 'Filters',
      active_label: 'Active filter',
      active: 'full_history',
      limit_label: 'Limit',
      limit: writtenPayload.timeline_meta.limit,
      shown_count: writtenPayload.timeline_meta.shown_count,
      total_count: writtenPayload.timeline_meta.total_count,
      hidden_count: writtenPayload.timeline_meta.hidden_count,
      truncated_label: 'Truncated',
      truncated: writtenPayload.timeline_meta.truncated,
      items: [
        { key: 'latest', label: 'Latest', command: writtenPayload.commands.timeline, active: false },
        { key: 'full_history', label: 'Full history', command: 'atris mission timeline landing-timeline-codex-loop --all', active: true },
      ],
    });
    assert.equal(writtenPayload.artifact_path, 'atris/reports/landing-timeline-codex-loop-timeline.md');
    assert.deepEqual(writtenPayload.artifact, {
      path: 'atris/reports/landing-timeline-codex-loop-timeline.md',
      written: true,
      format: 'markdown',
    });
    assert.deepEqual(writtenPayload.artifact_display, {
      label: 'Artifact',
      path_label: 'Path',
      path: 'atris/reports/landing-timeline-codex-loop-timeline.md',
      written_label: 'Written',
      written: true,
      format_label: 'Format',
      format: 'markdown',
    });
    assert.deepEqual(writtenPayload.export_display, {
      label: 'Export',
      command: writtenPayload.commands.export,
      report_label: 'Saved report',
      report_path: 'atris/reports/landing-timeline-codex-loop-timeline.md',
      report_written: true,
      report_format: 'markdown',
    });
    assert.deepEqual(writtenPayload.receipt_display, {
      label: 'Receipts',
      latest_label: 'Latest receipt',
      latest_path: writtenPayload.current_landing.receipt_path,
      has_latest: true,
      count_label: 'Receipts',
      count: writtenPayload.timeline.filter((item) => item.receipt_path).length,
      items: writtenPayload.timeline.map((item, index) => ({
        index: index + 1,
        label: `Receipt ${index + 1}`,
        path: item.receipt_path,
        at: item.at,
        current: item.receipt_path === writtenPayload.current_landing.receipt_path,
      })),
    });
    assert.deepEqual(writtenPayload.proof_display, {
      label: 'Proof',
      latest_receipt_label: 'Latest receipt',
      latest_receipt_path: writtenPayload.current_landing.receipt_path,
      report_label: 'Saved report',
      report_path: 'atris/reports/landing-timeline-codex-loop-timeline.md',
      report_written: true,
      report_format: 'markdown',
    });
    const writtenMarkdown = fs.readFileSync(path.join(dir, 'atris', 'reports', 'landing-timeline-codex-loop-timeline.md'), 'utf8');
    assert.ok(writtenMarkdown.includes(`Generated at: ${writtenPayload.generated_at}`), writtenMarkdown);
    assert.equal(writtenPayload.prune_summary?.ok, true);
    assert.match(writtenPayload.prune_summary?.text, /Prune dry-run: \d+ files \/ [^)]+ would prune; \d+ deleted\./);
    assert.equal(typeof writtenPayload.prune_summary?.prune_count, 'number');
    assert.equal(typeof writtenPayload.prune_summary?.prune_bytes_text, 'string');
    assert.deepEqual(writtenPayload.prune_display, {
      label: 'Prune preview',
      command: writtenPayload.commands.prune_preview,
      available: true,
      ok: true,
      summary: writtenPayload.prune_summary.text,
      would_prune_label: 'Would prune',
      prune_count: writtenPayload.prune_summary.prune_count,
      prune_bytes_text: writtenPayload.prune_summary.prune_bytes_text,
      deleted_label: 'Deleted',
      deleted_count: writtenPayload.prune_summary.deleted_count,
    });
  } finally {
    cleanupTempDir(dir);
  }
});

test('mission report does not double-prefix goal summaries', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const started = runCli([
      'mission',
      'start',
      'timeline duplicate proof mission',
      '--owner',
      'mission-lead',
      '--json',
    ], { cwd: dir });
    assert.equal(started.status, 0, started.stderr || started.stdout);
    const mission = JSON.parse(started.stdout).mission;

    const tick = runCli([
      'mission',
      'tick',
      mission.id,
      '--summary',
      'Goal 1: First goal done - built the owner route',
      '--json',
    ], { cwd: dir });
    assert.equal(tick.status, 0, tick.stderr || tick.stdout);

    const report = runCli(['mission', 'report', mission.id], { cwd: dir });
    assert.equal(report.status, 0, report.stderr || report.stdout);
    assert.match(report.stdout, /Goal 1: First goal done - built the owner route/);
    assert.doesNotMatch(report.stdout, /Goal 1: Goal 1:/);

    const json = runCli(['mission', 'report', mission.id, '--json'], { cwd: dir });
    assert.equal(json.status, 0, json.stderr || json.stdout);
    const payload = JSON.parse(json.stdout);
    assert.equal(payload.reports[0].timeline[0].title, 'Goal 1: First goal done - built the owner route');
  } finally {
    cleanupTempDir(dir);
  }
});

test('mission report preserves explicit goal labels when tick index differs', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const started = runCli([
      'mission',
      'start',
      'timeline mismatched goal label mission',
      '--owner',
      'mission-lead',
      '--json',
    ], { cwd: dir });
    assert.equal(started.status, 0, started.stderr || started.stdout);
    const mission = JSON.parse(started.stdout).mission;

    const tick = runCli([
      'mission',
      'tick',
      mission.id,
      '--summary',
      'Goal 42: made mission status JSON honest',
      '--json',
    ], { cwd: dir });
    assert.equal(tick.status, 0, tick.stderr || tick.stdout);

    const report = runCli(['mission', 'report', mission.id], { cwd: dir });
    assert.equal(report.status, 0, report.stderr || report.stdout);
    assert.match(report.stdout, /Goal 42: made mission status JSON honest/);
    assert.doesNotMatch(report.stdout, /Goal 1: Goal 42:/);

    const json = runCli(['mission', 'report', mission.id, '--json'], { cwd: dir });
    assert.equal(json.status, 0, json.stderr || json.stdout);
    const payload = JSON.parse(json.stdout);
    assert.equal(payload.reports[0].timeline[0].tick_index, 1);
    assert.equal(payload.reports[0].timeline[0].title, 'Goal 42: made mission status JSON honest');
  } finally {
    cleanupTempDir(dir);
  }
});

test('mission report keeps timeline titles short while preserving summaries', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const started = runCli([
      'mission',
      'start',
      'timeline title summary mission',
      '--owner',
      'mission-lead',
      '--json',
    ], { cwd: dir });
    assert.equal(started.status, 0, started.stderr || started.stdout);
    const mission = JSON.parse(started.stdout).mission;
    const summary = 'Goal 7: Built the owner proof card. Kept command output, receipts, and review detail in the full summary for agents.';

    const tick = runCli([
      'mission',
      'tick',
      mission.id,
      '--summary',
      summary,
      '--json',
    ], { cwd: dir });
    assert.equal(tick.status, 0, tick.stderr || tick.stdout);

    const report = runCli(['mission', 'report', mission.id], { cwd: dir });
    assert.equal(report.status, 0, report.stderr || report.stdout);
    const timelineLine = report.stdout.split(/\r?\n/).find((line) => line.includes('- Goal 7:'));
    assert.match(timelineLine, /Goal 7: Built the owner proof card\./);
    assert.doesNotMatch(timelineLine, /Kept command output, receipts, and review detail/);

    const json = runCli(['mission', 'report', mission.id, '--json'], { cwd: dir });
    assert.equal(json.status, 0, json.stderr || json.stdout);
    const payload = JSON.parse(json.stdout);
    assert.equal(payload.reports[0].timeline[0].title, 'Goal 7: Built the owner proof card.');
    assert.equal(payload.reports[0].timeline[0].summary, summary);
  } finally {
    cleanupTempDir(dir);
  }
});

test('mission report text prints next command without redundant next move prefix', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    appendMissionState(dir, {
      id: 'mission-next-text',
      slug: 'mission-next-text',
      objective: 'next text report mission',
      runner: 'codex_goal',
      status: 'ready',
      next_action: 'next move: run atris mission run mission-next-text',
      created_at: '2026-06-30T13:00:00.000Z',
      updated_at: '2026-06-30T13:00:00.000Z',
    });

    const report = runCli(['mission', 'report', 'mission-next-text'], { cwd: dir });
    assert.equal(report.status, 0, report.stderr || report.stdout);
    assert.match(report.stdout, /Next: atris mission run mission-next-text/);
    assert.doesNotMatch(report.stdout, /Next: next move:/);

    const json = runCli(['mission', 'report', 'mission-next-text', '--json'], { cwd: dir });
    assert.equal(json.status, 0, json.stderr || json.stdout);
    const payload = JSON.parse(json.stdout);
    assert.equal(payload.reports[0].operator_next, 'next move: run atris mission run mission-next-text');
  } finally {
    cleanupTempDir(dir);
  }
});

test('mission report hides empty caller-session handoff ticks from the timeline', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris', 'runs'), { recursive: true });
    const missionId = 'mission-caller-session-report';
    const tick = {
      status: 'ran',
      reason: 'caller-session-runner',
      tick_index: 8,
      finished_at: '2026-06-30T12:02:28.274Z',
      claude: { skipped: true, reason: 'runner-uses-caller-session' },
    };
    for (const [name, result] of [
      ['a', { kind: 'mission_tick', tick }],
      ['b', { kind: 'mission_run_summary', ticks: [tick] }],
    ]) {
      fs.writeFileSync(path.join(dir, 'atris', 'runs', `mission-${missionId}-${name}.json`), JSON.stringify({
        schema: 'atris.mission_receipt.v1',
        mission_id: missionId,
        objective: 'caller session report',
        owner: 'mission-lead',
        at: '2026-06-30T12:02:28.274Z',
        result,
      }, null, 2), 'utf8');
    }
    appendMissionState(dir, {
      id: missionId,
      slug: missionId,
      objective: 'caller session report',
      runner: 'codex_goal',
      status: 'running',
      receipt_path: `atris/runs/mission-${missionId}-b.json`,
      created_at: '2026-06-30T12:00:00.000Z',
      updated_at: '2026-06-30T12:03:00.000Z',
    });

    const report = runCli(['mission', 'report', missionId], { cwd: dir });
    assert.equal(report.status, 0, report.stderr || report.stdout);
    assert.doesNotMatch(report.stdout, /Timeline:/);
    assert.doesNotMatch(report.stdout, /Goal 8:/);
    assert.doesNotMatch(report.stdout, /runner-uses-caller-session|caller-session-runner/);

    const json = runCli(['mission', 'report', missionId, '--json'], { cwd: dir });
    assert.equal(json.status, 0, json.stderr || json.stdout);
    const payload = JSON.parse(json.stdout);
    assert.equal(payload.reports[0].timeline.length, 0);
  } finally {
    cleanupTempDir(dir);
  }
});

test('mission action missing lookups are JSON-readable', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const cases = [
      ['tick', ['mission', 'tick', 'mission-missing', '--json']],
      ['run', ['mission', 'run', 'mission-missing', '--json']],
      ['complete', ['mission', 'complete', 'mission-missing', '--proof', 'probe', '--json']],
      ['stop', ['mission', 'stop', 'mission-missing', '--json']],
    ];

    for (const [name, args] of cases) {
      const result = runCli(args, { cwd: dir });
      assert.equal(result.status, 1, name);
      assert.equal(result.stderr, '', name);
      assert.deepEqual(JSON.parse(result.stdout), {
        ok: false,
        error: 'Mission "mission-missing" not found.',
      }, name);
    }

    const humanTick = runCli(['mission', 'tick', 'mission-missing'], { cwd: dir });
    assert.equal(humanTick.status, 1);
    assert.equal(humanTick.stdout, '');
    assert.match(humanTick.stderr, /Mission "mission-missing" not found\./);
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
        'Usage: atris mission start "<objective>" --owner <member> [--verify "..."] [--cadence manual] [--worktree]',
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

test('mission run terminal skips are JSON-readable when mission is explicit', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const stopped = startMission(dir, 'terminal run skip');
    const stop = runCli(['mission', 'stop', stopped.id, '--reason', 'done', '--json'], { cwd: dir });
    assert.equal(stop.status, 0, stop.stderr || stop.stdout);

    const run = runCli(['mission', 'run', stopped.id, '--json'], { cwd: dir });
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

test('mission run with an objective starts a visible-goal mission', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const run = runCli(['mission', 'run', 'atris mission run', '--json'], { cwd: dir });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    assert.equal(run.stderr, '');
    const payload = JSON.parse(run.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.action, 'mission_run_started');
    assert.equal(payload.mission.objective, 'atris mission run');
    assert.equal(payload.mission.runner, 'codex_goal');
    assert.match(payload.mission.verifier, /atris-mission-run-verifier/);
    assert.match(payload.mission.verifier, /verifier smoke objective/);
    assert.equal(payload.mission.stop_condition, 'verifier passes and visible goal lands');
    assert.equal(payload.warnings.length, 0);
    assert.equal(payload.codex_goal_state.action, 'codex_goal_candidate');
    assert.equal(payload.codex_goal_state.goal.objective, 'atris mission run');
    assert.equal(payload.codex_goal_state.goal.visible_goal.schema, 'atris.visible_chat_goal_bridge.v1');
    assert.equal(payload.requires_native_goal_start, true);
    assert.deepEqual(payload.native_goal_action, {
      runtime: 'codex',
      tool: 'create_goal',
      args: { objective: 'atris mission run' },
    });
    assert.match(payload.next_command, /create_goal/);
    assert.match(payload.next_command, /mission goal ack/);
    assert.equal(payload.codex_goal_state.goal.requires_native_goal_start, true);
    assert.equal(payload.codex_goal_state.goal.native_goal_action.tool, 'create_goal');
    assert.match(payload.codex_goal_state.goal.native_goal_ack_command, /mission goal ack/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('mission run preflights messy shower input before writing the visible goal', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const rawObjective = 'ok lets try atris mission run for 10 minutes while i shower: messy input should become the right mission input, visible goal, task spine, proof receipt, and next action; use the whole 10 minutes';
    const run = runCli(['mission', 'run', rawObjective, '--owner', 'mission-lead', '--json'], { cwd: dir });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    assert.equal(run.stderr, '');
    const payload = JSON.parse(run.stdout);
    const preflight = payload.mission.mission_run_preflight;

    assert.equal(payload.action, 'mission_run_started');
    assert.equal(preflight.schema, 'atris.mission_run_preflight.v1');
    assert.equal(preflight.source, 'mission_room');
    assert.equal(preflight.raw_objective, rawObjective);
    assert.equal(payload.mission.raw_objective, rawObjective);
    assert.notEqual(payload.mission.objective, rawObjective);
    assert.equal(payload.mission.objective, preflight.shaped_objective);
    assert.match(payload.mission.objective, /Messy Input Goal Chain Mission Room with mission-lead/);
    assert.match(payload.mission.objective, /one visible goal, task spine, proof receipt, and next action/);
    assert.equal(payload.codex_goal_state.goal.objective, preflight.visible_goal_objective);
    assert.equal(payload.codex_goal_state.goal.visible_goal.desired_objective, preflight.visible_goal_objective);
    assert.notEqual(payload.native_goal_action.args.objective, rawObjective);
    assert.equal(payload.native_goal_action.args.objective, preflight.visible_goal_objective);
    assert.equal(payload.direct_goal_request.objective, preflight.visible_goal_objective);
    assert.equal(payload.direct_goal_request.mission_run_preflight.raw_objective, rawObjective);
    assert.equal(payload.budget_contract.policy, 'spend_full_budget');
    assert.equal(payload.budget_contract.requested_seconds, 600);
    assert.equal(payload.mission.xp_task.ref, payload.codex_goal_state.goal.task_spine.task_ref);
    assert.equal(payload.codex_goal_state.goal.task_spine.has_task, true);
    assert.equal(payload.codex_goal_state.goal.task_spine.current_step_command.includes('atris task current-step'), true);
    assert.equal(fs.existsSync(path.join(dir, preflight.room_receipt_path)), true);
    const receipt = JSON.parse(fs.readFileSync(path.join(dir, preflight.room_receipt_path), 'utf8'));
    assert.equal(receipt.schema, 'atris.mission_room_receipt.v1');
    assert.equal(receipt.room.name, 'Messy Input Goal Chain Mission Room');
  } finally {
    cleanupTempDir(dir);
  }
});

test('mission run reports replace action when a paused native-only goal blocks create', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const run = runCli([
      'mission',
      'run',
      'edited paused goal test',
      '--native-goal-status',
      'paused',
      '--native-goal-objective',
      'heyyy',
      '--json',
    ], { cwd: dir });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    assert.equal(run.stderr, '');
    const payload = JSON.parse(run.stdout);
    const mission = payload.mission;
    assert.equal(payload.ok, true);
    assert.equal(payload.action, 'mission_run_started');
    assert.equal(payload.codex_goal_state.action, 'codex_goal_candidate');
    assert.equal(payload.codex_goal_state.goal.objective, 'edited paused goal test');
    assert.equal(payload.codex_goal_state.goal.runtime_goal_state.status, 'paused');
    assert.equal(payload.codex_goal_state.goal.runtime_goal_state.objective, 'heyyy');
    assert.equal(payload.requires_native_goal_start, true);
    assert.equal(payload.requires_native_goal_replace, true);
    assert.equal(payload.native_goal_action.tool, 'replace_goal');
    assert.equal(payload.native_goal_action.available, false);
    assert.equal(payload.native_goal_action.blocked_by, 'codex_runtime_missing_replace_goal_tool');
    assert.equal(payload.native_goal_action.args.from_objective, 'heyyy');
    assert.equal(payload.native_goal_action.args.to_objective, 'edited paused goal test');
    assert.equal(payload.native_goal_action.args.from_mission_id, null);
    assert.equal(payload.native_goal_action.args.to_mission_id, mission.id);
    assert.equal(payload.native_goal_action.args.current_status, 'paused');
    assert.equal(
      payload.native_goal_action.after_success.ack_new_mission,
      `atris mission goal ack ${mission.id} --runtime codex --status active --objective 'edited paused goal test' --json`,
    );
    assert.equal(payload.native_goal_action.fallback.automatic, false);
    assert.equal(payload.native_goal_action.fallback.blocked_by, 'native_goal_cancel_or_supersede_tool_missing');
    assert.equal(payload.native_goal_action.fallback.sequence_name, 'complete_paused_goal_then_create_new_goal');
    assert.deepEqual(payload.native_goal_action.fallback.sequence, [
      'update_goal({ status: "complete" })',
      'create_goal({ objective: "edited paused goal test" })',
      `atris mission goal ack ${mission.id} --runtime codex --status active --objective 'edited paused goal test' --json`,
    ]);
    assert.match(payload.native_goal_action.fallback.safe_when, /intentionally superseded/);
    assert.match(payload.next_command, /replace_goal is required/);
    assert.match(payload.next_command, /this runtime currently lacks replace_goal/);
    assert.match(payload.next_command, /only after handoff proof/);

    const goal = runCli([
      'mission',
      'goal',
      '--native-goal-status',
      'paused',
      '--native-goal-objective',
      'heyyy',
      '--json',
    ], { cwd: dir });
    assert.equal(goal.status, 0, goal.stderr || goal.stdout);
    const goalPayload = JSON.parse(goal.stdout);
    assert.equal(goalPayload.action, 'codex_goal_candidate');
    assert.equal(goalPayload.goal.mission_id, mission.id);
    assert.equal(goalPayload.native_goal_action.tool, 'replace_goal');
    assert.equal(goalPayload.native_goal_action.args.from_objective, 'heyyy');
    assert.equal(goalPayload.native_goal_action.fallback.commands.create_new_goal, 'create_goal({ objective: "edited paused goal test" })');
    assert.equal(goalPayload.requires_native_goal_replace, true);

    const approvedRun = runCli([
      'mission',
      'run',
      'approved paused goal test',
      '--native-goal-status',
      'paused',
      '--native-goal-objective',
      'heyyy',
      '--allow-native-goal-supersede',
      '--json',
    ], { cwd: dir });
    assert.equal(approvedRun.status, 0, approvedRun.stderr || approvedRun.stdout);
    const approvedPayload = JSON.parse(approvedRun.stdout);
    const approvedMission = approvedPayload.mission;
    assert.equal(approvedPayload.codex_goal_state.goal.objective, 'approved paused goal test');
    assert.equal(approvedPayload.native_goal_action.tool, 'replace_goal');
    assert.equal(approvedPayload.native_goal_action.fallback.approved, true);
    assert.equal(approvedPayload.native_goal_action.fallback.automatic, true);
    assert.equal(approvedPayload.native_goal_action.fallback.executable_now, true);
    assert.equal(approvedPayload.native_goal_action.fallback.blocked_by, null);
    assert.deepEqual(approvedPayload.native_goal_action.fallback.sequence, [
      'update_goal({ status: "complete" })',
      'create_goal({ objective: "approved paused goal test" })',
      `atris mission goal ack ${approvedMission.id} --runtime codex --status active --objective 'approved paused goal test' --json`,
    ]);
    assert.match(approvedPayload.next_command, /Supersede approved/);
    assert.match(approvedPayload.next_command, /Atris records the old paused goal as superseded/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('mission run objective reports active visible-goal conflict instead of hiding the new mission', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const oldRun = runCli(['mission', 'run', 'old visible goal', '--json'], { cwd: dir });
    assert.equal(oldRun.status, 0, oldRun.stderr || oldRun.stdout);
    const oldMission = JSON.parse(oldRun.stdout).mission;
    ackNativeCodexGoal(dir, oldMission);

    const pausedRuntimeRun = runCli([
      'mission',
      'run',
      'runtime paused new goal',
      '--native-goal-status',
      'paused',
      '--native-goal-objective',
      oldMission.objective,
      '--json',
    ], { cwd: dir });
    assert.equal(pausedRuntimeRun.status, 0, pausedRuntimeRun.stderr || pausedRuntimeRun.stdout);
    const pausedRuntimePayload = JSON.parse(pausedRuntimeRun.stdout);
    assert.equal(pausedRuntimePayload.codex_goal_state.action, 'paused_goal_conflict');
    assert.equal(pausedRuntimePayload.codex_goal_state.active_goal_conflict.status, 'paused_goal_conflict');
    assert.equal(pausedRuntimePayload.codex_goal_state.active_goal_conflict.new_objective, 'runtime paused new goal');
    assert.equal(pausedRuntimePayload.codex_goal_state.active_goal_conflict.runtime_goal_state.status, 'paused');
    assert.equal(pausedRuntimePayload.native_goal_action.tool, 'replace_goal');
    assert.equal(pausedRuntimePayload.native_goal_action.available, false);
    assert.equal(pausedRuntimePayload.native_goal_action.blocked_by, 'codex_runtime_missing_replace_goal_tool');
    assert.equal(pausedRuntimePayload.native_goal_action.args.from_mission_id, oldMission.id);
    assert.equal(pausedRuntimePayload.native_goal_action.args.to_objective, 'runtime paused new goal');
    assert.equal(pausedRuntimePayload.codex_goal_state.active_goal_conflict.native_goal_resolution.action, 'replace_visible_goal');
    assert.match(pausedRuntimePayload.next_command, /Resume the paused Codex goal/);

    const newRun = runCli(['mission', 'run', 'new urgent goal', '--json'], { cwd: dir });
    assert.equal(newRun.status, 0, newRun.stderr || newRun.stdout);
    const runPayload = JSON.parse(newRun.stdout);
    const newMission = runPayload.mission;
    assert.equal(runPayload.action, 'mission_run_started');
    assert.equal(runPayload.codex_goal_state.action, 'active_goal_conflict');
    assert.equal(runPayload.codex_goal_state.active_goal_conflict.new_mission_id, newMission.id);
    assert.equal(runPayload.codex_goal_state.active_goal_conflict.active_mission_id, oldMission.id);
    assert.equal(runPayload.native_goal_action.tool, 'replace_goal');
    assert.equal(runPayload.native_goal_action.args.from_objective, oldMission.objective);
    assert.equal(runPayload.native_goal_action.args.to_objective, newMission.objective);
    assert.equal(runPayload.codex_goal_state.native_goal_resolution.required_tool, 'replace_goal');
    assert.equal(runPayload.codex_goal_state.native_goal_resolution.executable_now, false);
    assert.equal(
      runPayload.codex_goal_state.active_goal_conflict.message,
      `new mission created, but old mission ${oldMission.id} still owns the visible slot.`,
    );
    assert.equal(runPayload.next_command, runPayload.codex_goal_state.active_goal_conflict.next_command);
    assert.match(runPayload.next_command, new RegExp(`mission pause ${oldMission.id}`));
    assert.match(runPayload.next_command, new RegExp(`mission goal ack ${newMission.id}`));
    assert.equal(
      runPayload.native_goal_ack_command,
      `atris mission goal ack ${newMission.id} --runtime codex --status active --objective 'new urgent goal' --json`,
    );

    const goal = runCli(['mission', 'goal', '--json'], { cwd: dir });
    assert.equal(goal.status, 0, goal.stderr || goal.stdout);
    const goalPayload = JSON.parse(goal.stdout);
    assert.equal(goalPayload.action, 'active_goal_conflict');
    assert.equal(goalPayload.active_goal_conflict.new_mission_id, newMission.id);
    assert.equal(goalPayload.active_goal_conflict.active_mission_id, oldMission.id);
    assert.equal(goalPayload.native_goal_action.tool, 'replace_goal');
    assert.equal(goalPayload.native_goal_action.after_success.ack_new_mission, goalPayload.active_goal_conflict.commands.ack_new_mission);
    assert.equal(goalPayload.next_command, goalPayload.active_goal_conflict.next_command);
    assert.equal(
      goalPayload.active_goal_conflict.commands.ack_new_mission,
      `atris mission goal ack ${newMission.id} --runtime codex --status active --objective 'new urgent goal' --json`,
    );
    assert.equal(
      goalPayload.active_goal_conflict.commands.hold_old_mission,
      `atris mission pause ${oldMission.id} --reason 'visible goal replaced by ${newMission.id}' --json`,
    );

    const status = fs.readFileSync(path.join(dir, 'atris', 'status', 'codex-goal.md'), 'utf8');
    assert.match(status, new RegExp(`new mission created, but old mission ${oldMission.id} still owns the visible slot\\.`));
    assert.match(status, new RegExp(`new mission: ${newMission.id}`));
    assert.match(status, /native goal action: replace_goal/);
    assert.match(status, /native goal executable now: false/);

    const pausedGoal = runCli([
      'mission',
      'goal',
      '--native-goal-status',
      'paused',
      '--native-goal-objective',
      oldMission.objective,
      '--json',
    ], { cwd: dir });
    assert.equal(pausedGoal.status, 0, pausedGoal.stderr || pausedGoal.stdout);
    const pausedGoalPayload = JSON.parse(pausedGoal.stdout);
    assert.equal(pausedGoalPayload.action, 'paused_goal_conflict');
    assert.equal(pausedGoalPayload.active_goal_conflict.status, 'paused_goal_conflict');
    assert.equal(pausedGoalPayload.active_goal_conflict.new_mission_id, newMission.id);
    assert.equal(pausedGoalPayload.active_goal_conflict.active_mission_id, oldMission.id);
    assert.equal(pausedGoalPayload.active_goal_conflict.runtime_goal_state.status, 'paused');
    assert.equal(pausedGoalPayload.active_goal_conflict.runtime_goal_state.objective, oldMission.objective);
    assert.equal(pausedGoalPayload.native_goal_action.tool, 'replace_goal');
    assert.equal(pausedGoalPayload.native_goal_action.available, false);
    assert.equal(pausedGoalPayload.native_goal_action.args.current_status, 'paused');
    assert.match(pausedGoalPayload.next_command, /Resume the paused Codex goal/);
    assert.equal(
      pausedGoalPayload.active_goal_conflict.commands.refresh_after_resume,
      `atris mission goal --native-goal-status active --native-goal-objective 'old visible goal' --json`,
    );

    const holdOld = runCli(['mission', 'pause', oldMission.id, '--reason', `visible goal replaced by ${newMission.id}`, '--json'], { cwd: dir });
    assert.equal(holdOld.status, 0, holdOld.stderr || holdOld.stdout);
    const afterHold = runCli(['mission', 'goal', '--json'], { cwd: dir });
    assert.equal(afterHold.status, 0, afterHold.stderr || afterHold.stdout);
    const afterHoldPayload = JSON.parse(afterHold.stdout);
    assert.equal(afterHoldPayload.action, 'codex_goal_candidate');
    assert.equal(afterHoldPayload.goal.reason, 'direct_run');
    assert.equal(afterHoldPayload.goal.mission_id, newMission.id);
    assert.equal(afterHoldPayload.goal.next_command, `Call native Codex create_goal({ objective: "new urgent goal" }), then run atris mission goal ack ${newMission.id} --runtime codex --status active --objective 'new urgent goal' --json`);
  } finally {
    cleanupTempDir(dir);
  }
});

test('mission room turns messy input into a shareable receipt', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const memberDir = path.join(dir, 'atris', 'team', 'mission-lead');
    fs.mkdirSync(path.join(memberDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(memberDir, 'MEMBER.md'), '# Mission Lead\n\nOwns Mission Room loops.\n', 'utf8');
    fs.writeFileSync(path.join(memberDir, 'MISSION.md'), '# Mission\n\nTurn messy intent into proof-backed missions.\n', 'utf8');
    fs.writeFileSync(path.join(memberDir, 'now.md'), '# Now\n\nMission Room context slice.\n', 'utf8');
    fs.writeFileSync(path.join(memberDir, 'logs', '2026-06-30.md'), '# Mission Lead Log\n\n- last proof: thinking.md memory\n', 'utf8');
    fs.mkdirSync(path.join(dir, 'atris', 'logs', '2026'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'logs', '2026', '2026-06-30.md'), '# Daily Log\n\n- next: proactive mission room\n', 'utf8');

    const input = '30 days of runway. DoorDash PO exists but we cannot collect it tonight. Warm buyer mission loops waste time. We need product-led growth. Pick one concrete product proof that helps us get cash or adoption fast.';
    const res = runCli(['mission', 'room', input, '--owner', 'mission-lead', '--json'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.equal(res.stderr, '');

    const payload = JSON.parse(res.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.action, 'mission_room_created');
    assert.equal(payload.room.schema, 'atris.mission_room.v1');
    assert.equal(payload.room.name, 'Ship Product-Led Cash Proof Mission Room');
    assert.match(payload.room.target_outcome, /proof-backed mission/);
    assert.equal(payload.room.clarifying_questions.length, 3);
    assert.match(payload.room.clarifying_questions[0].question, /undeniably done/);
    assert.equal(payload.room.approval_packet.status, 'awaiting_operator_approval');
    assert.match(payload.room.approval_packet.operator_role, /judgment, priority, and final accept/);
    assert.deepEqual(payload.room.approval_packet.decision_options, ['approve', 'revise', 'stop']);
    assert.equal(payload.room.goal_chain.mode, 'approval_gated');
    assert.match(payload.room.goal_chain.loop, /clarify -> approve packet -> set one goal/);
    assert.equal(payload.room.chat_zone.schema, 'atris.mission_room_chat_zone.v1');
    assert.equal(payload.room.chat_zone.status, 'clarifying');
    assert.match(payload.room.chat_zone.execution_policy, /Do not start a mission goal until the operator approves/);
    assert.match(payload.room.chat_zone.result_landing_policy, /only after a bounded goal runs/);
    assert.equal(payload.room.chat_zone.plan_preview.mission, payload.room.name);
    assert.equal(payload.room.timeline_preview.schema, 'atris.mission_room_timeline_preview.v1');
    assert.equal(payload.room.timeline_preview.mode, 'human_goal_chain');
    assert.deepEqual(
      payload.room.timeline_preview.items.map((item) => item.title),
      ['Messy ask captured', 'Goal set', 'Goal done', 'Next goal set', 'Mission accomplished'],
    );
    assert.equal(payload.room.timeline_preview.items.every((item) => item.did && item.meant), true);
    assert.equal(payload.room.task_plan_preview.schema, 'atris.mission_room_task_plan_preview.v1');
    assert.equal(payload.room.task_plan_preview.order, 'task_first');
    assert.equal(payload.room.task_plan_preview.mission, payload.room.name);
    assert.match(payload.room.task_plan_preview.first_goal, /Prove .* Mission Room/);
    assert.match(payload.room.task_plan_preview.stop_rule, /one proof receipt/);
    assert.equal(payload.room.task_plan_preview.member_route.suggested_member, 'mission-lead');
    assert.equal(payload.room.task_plan_preview.member_route.editable, true);
    assert.match(payload.room.task_plan_preview.preview_then_route, /First understand the task/);
    assert.equal(payload.room.member_route.status, 'suggested_member');
    assert.equal(payload.room.member_route.suggested_member, 'mission-lead');
    assert.equal(payload.room.member_route.editable, true);
    assert.match(payload.room.member_route.approval_prompt, /Approve or change the member/);
    assert.match(payload.room.member_route.change_hint, /--owner <member>/);
    assert.equal(payload.room.result.schema, 'atris.mission_room_result.v1');
    assert.equal(payload.room.result.status, 'pending_goal_run');
    assert.equal(payload.room.result.landing.status, 'pending_goal_run');
    assert.match(payload.room.result.landing.changed, /Room open:/);
    assert.match(payload.room.result.landing.checked, /no mission goal has run yet/);
    assert.equal(payload.room.result.landing.proof, null);
    assert.match(payload.room.result.landing.decision, /Approve to start one bounded goal/);
    assert.deepEqual(
      payload.room.result.landing.timeline_preview.map((item) => item.title),
      ['Messy ask captured', 'Goal set', 'Goal done', 'Next goal set', 'Mission accomplished'],
    );
    assert.equal(payload.room.member_context.status, 'member_selected');
    assert.equal(payload.room.member_context.member_exists, true);
    assert.equal(payload.room.context.selected_member, 'mission-lead');
    assert.equal(payload.room.context.available_members.includes('mission-lead'), true);
    assert.equal(payload.room.member_context.files.some((file) => file.path === 'atris/team/mission-lead/MEMBER.md'), true);
    assert.equal(payload.room.member_context.files.some((file) => file.path === 'atris/team/mission-lead/logs/2026-06-30.md'), true);
    assert.equal(payload.room.memory_context.thinking.path, 'atris/thinking.md');
    assert.equal(payload.room.memory_context.thinking.exists, true);
    assert.equal(payload.room.memory_context.workspace_log.path, 'atris/logs/2026/2026-06-30.md');
    assert.equal(payload.room.proactive_next_mission.status, 'suggested_after_operator_approval');
    assert.match(payload.room.proactive_next_mission.objective, /first proof receipt/);
    assert.equal(payload.room.proactive_next_mission.selected_member, 'mission-lead');
    assert.equal(payload.room.proactive_next_mission.context_paths.includes('atris/thinking.md'), true);
    assert.equal(payload.room.proactive_next_mission.context_paths.includes('atris/team/mission-lead/MEMBER.md'), true);
    assert.equal(payload.room.proactive_next_mission.context_paths.includes('atris/logs/2026/2026-06-30.md'), true);
    assert.equal(payload.room.thinking_memory.path, 'atris/thinking.md');
    assert.match(payload.room.thinking_memory.purpose, /how Keshav thinks/);
    assert.match(payload.room.first_proof_step, /smallest artifact or change/);
    assert.match(payload.room.verifier, /Receipt must include mission name/);
    assert.match(payload.room.share_line, /chaos to proof/);
    assert.match(payload.room.next_command, /After approval: atris mission start/);
    assert.match(payload.receipt_path, /^atris\/runs\/mission-room-/);

    const receiptPath = path.join(dir, payload.receipt_path);
    assert.equal(fs.existsSync(receiptPath), true);
    const thinkingPath = path.join(dir, 'atris/thinking.md');
    assert.equal(fs.existsSync(thinkingPath), true);
    const thinking = fs.readFileSync(thinkingPath, 'utf8');
    assert.match(thinking, /# thinking\.md/);
    assert.match(thinking, /Team logs say what happened\./);
    assert.match(thinking, /This file says how Keshav thinks\./);
    assert.match(thinking, new RegExp(payload.room.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    assert.equal(receipt.schema, 'atris.mission_room_receipt.v1');
    assert.equal(receipt.product_wedge, 'Chaos -> Mission Room');
    assert.equal(receipt.room.name, payload.room.name);
    assert.equal(receipt.room.approval_packet.status, 'awaiting_operator_approval');
    assert.equal(receipt.room.chat_zone.status, 'clarifying');
    assert.equal(receipt.room.task_plan_preview.order, 'task_first');
    assert.equal(receipt.room.timeline_preview.schema, 'atris.mission_room_timeline_preview.v1');
    assert.equal(receipt.room.member_route.editable, true);
    assert.equal(receipt.room.result.landing.status, 'pending_goal_run');
    assert.equal(receipt.room.member_context.status, 'member_selected');
    assert.equal(receipt.room.proactive_next_mission.selected_member, 'mission-lead');
    assert.equal(receipt.thinking_memory.path, 'atris/thinking.md');
  } finally {
    cleanupTempDir(dir);
  }
});

test('mission room text output leads with chat zone before execution', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const memberDir = path.join(dir, 'atris', 'team', 'mission-lead');
    fs.mkdirSync(path.join(memberDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(memberDir, 'MEMBER.md'), '# Mission Lead\n\nOwns Mission Room loops.\n', 'utf8');
    fs.writeFileSync(path.join(memberDir, 'MISSION.md'), '# Mission\n\nTurn messy intent into proof-backed missions.\n', 'utf8');
    fs.writeFileSync(path.join(memberDir, 'now.md'), '# Now\n\nMission Room context slice.\n', 'utf8');

    const input = 'I need a chat zone where we clarify the mission, preview the plan, then approve before any goal runs.';
    const res = runCli(['mission', 'room', input, '--owner', 'mission-lead'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr || res.stdout);

    assert.match(res.stdout, /Chat zone: clarifying \(no goal runs until approve\)/);
    assert.match(res.stdout, /Task plan preview:/);
    assert.match(res.stdout, /Approval: .*approve\/revise\/stop/);
    assert.match(res.stdout, /Result landing: pending_goal_run -> stays pending until a goal runs and proof exists/);
    assert.match(res.stdout, /After approve: atris mission start/);
    assert.doesNotMatch(res.stdout, /\n  Next:/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('mission room trusted mode previews then permits one bounded run', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const memberDir = path.join(dir, 'atris', 'team', 'mission-lead');
    fs.mkdirSync(path.join(memberDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(memberDir, 'MEMBER.md'), '# Mission Lead\n\nOwns Mission Room loops.\n', 'utf8');
    fs.writeFileSync(path.join(memberDir, 'MISSION.md'), '# Mission\n\nTurn messy intent into proof-backed missions.\n', 'utf8');
    fs.writeFileSync(path.join(memberDir, 'now.md'), '# Now\n\nMission Room context slice.\n', 'utf8');

    const input = 'one-message autonomy: improve atris-cli usefully without creating junk state';
    const res = runCli(['mission', 'room', input, '--owner', 'mission-lead', '--room-auto-run', '--json'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr || res.stdout);

    const payload = JSON.parse(res.stdout);
    assert.equal(payload.room.execution_mode, 'trusted_run');
    assert.equal(payload.room.goal_chain.mode, 'trusted_run');
    assert.equal(payload.room.chat_zone.status, 'ready_to_run');
    assert.match(payload.room.chat_zone.execution_policy, /Trusted run/);
    assert.equal(payload.room.result.landing.status, 'ready_to_run');
    assert.match(payload.room.next_command, /^After preview:/);
    assert.match(payload.room.approval_packet.approved_next_command, /--verify "git diff --check"/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('mission run trusted room selects real task before creating mission state', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.atris', 'state'), { recursive: true });
    const memberDir = path.join(dir, 'atris', 'team', 'mission-lead');
    fs.mkdirSync(path.join(memberDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(memberDir, 'MEMBER.md'), '# Mission Lead\n\nOwns Mission Room loops.\n', 'utf8');
    fs.writeFileSync(path.join(memberDir, 'MISSION.md'), '# Mission\n\nTurn messy intent into proof-backed missions.\n', 'utf8');
    fs.writeFileSync(path.join(memberDir, 'now.md'), '# Now\n\nMission Room context slice.\n', 'utf8');
    fs.writeFileSync(path.join(dir, '.atris', 'state', 'tasks.projection.json'), JSON.stringify({
      tasks: [
        {
          id: 'task-1',
          display_id: 'CLI-758',
          title: 'Make atris go execute one useful bounded slice',
          status: 'open',
          tag: 'autonomy',
          workspace_root: dir,
        },
      ],
    }, null, 2), 'utf8');

    const input = 'one-message autonomy: improve atris-cli usefully without creating junk state';
    const res = runCli(['mission', 'run', input, '--owner', 'mission-lead', '--json'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr || res.stdout);

    const payload = JSON.parse(res.stdout);
    assert.equal(payload.action, 'mission_run_started');
    assert.equal(payload.mission.objective, 'Make atris go execute one useful bounded slice');
    assert.equal(payload.mission.verifier, 'git diff --check');
    assert.equal(payload.mission.xp_task, undefined);
    assert.equal(payload.mission.mission_run_preflight.trusted_run, true);
    assert.equal(payload.mission.mission_run_preflight.selected_target.ref, 'CLI-758');
    assert.notEqual(payload.mission.objective, input);
    assert.doesNotMatch(payload.mission.objective, /go go go/i);
  } finally {
    cleanupTempDir(dir);
  }
});

test('mission room names next-mission decisions instead of recycling prior mission words', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const memberDir = path.join(dir, 'atris', 'team', 'mission-lead');
    fs.mkdirSync(path.join(memberDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(memberDir, 'MEMBER.md'), '# Mission Lead\n\nOwns Mission Room loops.\n', 'utf8');
    fs.writeFileSync(path.join(memberDir, 'MISSION.md'), '# Mission\n\nTurn messy intent into proof-backed missions.\n', 'utf8');
    fs.writeFileSync(path.join(memberDir, 'now.md'), '# Now\n\nMission Room context slice.\n', 'utf8');

    const input = 'We are using Atris Mission Room live right now. Keshav wants to decide the next useful mission after the cash-proof Mission Room. The immediate decision should be what mission to start next tonight.';
    const res = runCli(['mission', 'room', input, '--owner', 'mission-lead', '--json'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr || res.stdout);

    const payload = JSON.parse(res.stdout);
    assert.equal(payload.room.name, 'Decide Next Useful Mission Room');
    assert.notEqual(payload.room.name, 'Ship Cash Proof Mission Room');
    assert.match(payload.room.approval_packet.approve_question, /Decide Next Useful Mission Room/);
    assert.match(payload.room.proactive_next_mission.objective, /Decide Next Useful Mission Room/);
    assert.match(payload.receipt_path, /decide-next-useful-mission-room/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('mission room names messy input goal-chain runs specifically', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const memberDir = path.join(dir, 'atris', 'team', 'mission-lead');
    fs.mkdirSync(path.join(memberDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(memberDir, 'MEMBER.md'), '# Mission Lead\n\nOwns Mission Room loops.\n', 'utf8');
    fs.writeFileSync(path.join(memberDir, 'MISSION.md'), '# Mission\n\nTurn messy intent into proof-backed missions.\n', 'utf8');
    fs.writeFileSync(path.join(memberDir, 'now.md'), '# Now\n\nMission Room context slice.\n', 'utf8');

    const input = 'messy shower test: user gives messy input and Atris must turn it into the right mission input, choose the right member, set a visible goal, think bottleneck-first, create tasks if needed, and land a specific finish-line plan';
    const res = runCli(['mission', 'room', input, '--owner', 'mission-lead', '--json'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr || res.stdout);

    const payload = JSON.parse(res.stdout);
    assert.equal(payload.room.name, 'Messy Input Goal Chain Mission Room');
    assert.match(payload.room.approval_packet.approve_question, /Messy Input Goal Chain Mission Room/);
    assert.match(payload.room.proactive_next_mission.objective, /Messy Input Goal Chain Mission Room/);
    assert.match(payload.receipt_path, /messy-input-goal-chain-mission-room/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('mission prune-runs previews and deletes only old unreferenced run clutter', () => {
  const dir = makeTempDir();
  try {
    const runsDir = path.join(dir, 'atris', 'runs');
    const stateDir = path.join(dir, '.atris', 'state');
    fs.mkdirSync(runsDir, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });

    const oldUnreferenced = path.join(runsDir, 'old-unreferenced.json');
    const oldText = path.join(runsDir, 'old-note.txt');
    const oldReferenced = path.join(runsDir, 'old-referenced.json');
    const recent = path.join(runsDir, 'recent.json');
    fs.writeFileSync(oldUnreferenced, JSON.stringify({
      schema: 'atris.mission_receipt.v1',
      mission_id: 'old',
      objective: 'old clutter',
      result: { kind: 'mission_tick', tick: { summary: 'old clutter summary' } },
    }), 'utf8');
    fs.writeFileSync(oldText, 'temporary note', 'utf8');
    fs.writeFileSync(oldReferenced, JSON.stringify({
      schema: 'atris.mission_receipt.v1',
      mission_id: 'referenced',
      objective: 'referenced proof',
      result: { passed: true },
    }), 'utf8');
    fs.writeFileSync(recent, JSON.stringify({ schema: 'atris.mission_receipt.v1', mission_id: 'recent' }), 'utf8');
    const oldDate = new Date('2026-01-01T00:00:00.000Z');
    fs.utimesSync(oldUnreferenced, oldDate, oldDate);
    fs.utimesSync(oldText, oldDate, oldDate);
    fs.utimesSync(oldReferenced, oldDate, oldDate);
    fs.writeFileSync(path.join(stateDir, 'missions.jsonl'), JSON.stringify({
      id: 'mission-referenced',
      receipt_path: 'atris/runs/old-referenced.json',
    }) + '\n', 'utf8');

    const preview = runCli(['mission', 'prune-runs', '--days', '1', '--keep-newest', '1', '--json'], { cwd: dir });
    assert.equal(preview.status, 0, preview.stderr || preview.stdout);
    const previewPayload = JSON.parse(preview.stdout);
    assert.equal(previewPayload.applied, false);
    assert.equal(previewPayload.prune_count, 2);
    assert(previewPayload.candidates.some((entry) => entry.path === 'atris/runs/old-unreferenced.json'));
    assert(previewPayload.candidates.some((entry) => entry.path === 'atris/runs/old-note.txt'));
    assert.equal(fs.existsSync(oldUnreferenced), true);

    const applied = runCli(['mission', 'prune-runs', '--days', '1', '--keep-newest', '1', '--apply', '--json'], { cwd: dir });
    assert.equal(applied.status, 0, applied.stderr || applied.stdout);
    const payload = JSON.parse(applied.stdout);
    assert.equal(payload.applied, true);
    assert.equal(payload.deleted_count, 2);
    assert.match(payload.manifest_path, /^atris\/runs\/_archive\/prune-/);
    assert.equal(fs.existsSync(oldUnreferenced), false);
    assert.equal(fs.existsSync(oldText), false);
    assert.equal(fs.existsSync(oldReferenced), true);
    assert.equal(fs.existsSync(recent), true);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, payload.manifest_path), 'utf8'));
    assert.equal(manifest.schema, 'atris.runs_prune_manifest.v1');
    assert.equal(manifest.pruned_count, 2);
    assert(manifest.entries.some((entry) => entry.compact?.objective === 'old clutter'));
  } finally {
    cleanupTempDir(dir);
  }
});

test('mission run blocks Codex-goal work until native goal ack', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const run = runCli(['mission', 'run', 'handshake test', '--json'], { cwd: dir });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    const started = JSON.parse(run.stdout);
    const id = started.mission.id;

    const blockedTick = runCli(['mission', 'tick', id, '--summary', 'work before ack', '--json'], { cwd: dir });
    assert.equal(blockedTick.status, 2, blockedTick.stderr || blockedTick.stdout);
    const blockedTickPayload = JSON.parse(blockedTick.stdout);
    assert.equal(blockedTickPayload.ok, false);
    assert.equal(blockedTickPayload.code, 'native_goal_not_started');
    assert.equal(blockedTickPayload.native_goal_action.tool, 'create_goal');
    assert.match(blockedTickPayload.next_action, /mission goal ack/);

    const blockedRun = runCli(['mission', 'run', id, '--json', '--no-claude'], { cwd: dir });
    assert.equal(blockedRun.status, 2, blockedRun.stderr || blockedRun.stdout);
    assert.equal(JSON.parse(blockedRun.stdout).code, 'native_goal_not_started');

    const ack = runCli([
      'mission',
      'goal',
      'ack',
      id,
      '--runtime',
      'codex',
      '--status',
      'active',
      '--objective',
      'handshake test',
      '--json',
    ], { cwd: dir });
    assert.equal(ack.status, 0, ack.stderr || ack.stdout);
    const ackPayload = JSON.parse(ack.stdout);
    assert.equal(ackPayload.action, 'native_goal_acknowledged');
    assert.equal(ackPayload.native_goal_ack.status, 'active');
    assert.equal(ackPayload.codex_goal_state.goal.visible_goal.status, 'active');
    assert.equal(ackPayload.codex_goal_state.goal.requires_native_goal_start, false);

    const tick = runCli(['mission', 'tick', id, '--summary', 'work after ack', '--json'], { cwd: dir });
    assert.equal(tick.status, 0, tick.stderr || tick.stdout);
    assert.equal(JSON.parse(tick.stdout).action, 'mission_tick');
  } finally {
    cleanupTempDir(dir);
  }
});

test('mission ack attach preserves state when commands race', async () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const objective = 'ack attach race mission';
    const started = runCli([
      'mission',
      'start',
      objective,
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

    const [ack, attach] = await Promise.all([
      runCliAsync([
        'mission',
        'goal',
        'ack',
        mission.id,
        '--runtime',
        'codex',
        '--status',
        'active',
        '--objective',
        objective,
        '--json',
      ], { cwd: dir }),
      runCliAsync(['mission', 'attach-task', mission.id, '--json'], { cwd: dir }),
    ]);
    assert.equal(ack.status, 0, ack.stderr || ack.stdout);
    assert.equal(attach.status, 0, attach.stderr || attach.stdout);

    const status = runCli(['mission', 'status', mission.id, '--json'], { cwd: dir });
    assert.equal(status.status, 0, status.stderr || status.stdout);
    const saved = JSON.parse(status.stdout).missions[0];
    assert.equal(saved.native_goal_ack.status, 'active');
    assert.equal(saved.native_goal_ack.objective, objective);
    assert.equal(saved.task_spine.has_task, true);
    assert.equal(saved.task_spine.task_ref, saved.xp_task.ref);

    const goal = runCli(['mission', 'goal', '--json'], { cwd: dir });
    assert.equal(goal.status, 0, goal.stderr || goal.stdout);
    const goalPayload = JSON.parse(goal.stdout);
    assert.equal(goalPayload.goal.visible_goal.status, 'active');
    assert.equal(goalPayload.goal.task_spine.has_task, true);
    assert.equal(goalPayload.goal.next_command, 'atris mission run --due --max-ticks 1 --complete-on-pass');
  } finally {
    cleanupTempDir(dir);
  }
});

test('mission run with overnight self-improve objective configures a heartbeat-shaped mission', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const rawObjective = 'work overnight and see where we can self improve. goal after goal nonstop 6 hours';
    const run = runCli([
      'mission',
      'run',
      rawObjective,
      '--json',
    ], { cwd: dir });
    assert.equal(run.status, 0, run.stderr || run.stdout);

    const payload = JSON.parse(run.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.action, 'mission_run_started');
    assert.equal(payload.mission.owner, 'auto-improver');
    assert.equal(payload.mission.cadence, '13m');
    assert.equal(payload.mission.always_on, true);
    assert.equal(payload.mission.verifier, 'git diff --check');
    assert.equal(payload.mission.overnight_loop.requested_hours, 6);
    assert.equal(payload.mission.overnight_loop.cadence, '13m');
    assert.match(payload.mission.overnight_loop.install_command, /--hours 6/);
    assert.match(payload.mission.stop_condition, /run for 6 hours/);
    assert.equal(payload.mission.raw_objective, rawObjective);
    assert.equal(payload.mission.mission_run_preflight.raw_objective, rawObjective);
    assert.notEqual(payload.mission.objective, rawObjective);
    assert.match(payload.mission.objective, /Mission Room with auto-improver/);
    assert.match(payload.mission.objective, /one visible goal, task spine, proof receipt, and next action/);
    assert.equal(payload.codex_goal_state.goal.objective, payload.mission.mission_run_preflight.visible_goal_objective);
    assert.equal(payload.mission.xp_task.ref, payload.codex_goal_state.goal.task_spine.task_ref);
    assert.equal(fs.existsSync(path.join(dir, payload.mission.mission_run_preflight.room_receipt_path)), true);
  } finally {
    cleanupTempDir(dir);
  }
});

test('mission run treats plain time as a finish-early budget by default', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const run = runCli([
      'mission',
      'run',
      'fix the hvac dispatch handoff in 20 minutes',
      '--json',
    ], { cwd: dir });
    assert.equal(run.status, 0, run.stderr || run.stdout);

    const payload = JSON.parse(run.stdout);
    assert.equal(payload.action, 'mission_run_started');
    assert.equal(payload.budget_contract.policy, 'stop_when_done');
    assert.equal(payload.budget_contract.requested_seconds, 1200);
    assert.equal(payload.budget_contract.plain_language, 'Finish early if solved.');
    assert.equal(payload.mission.max_wall_seconds, 1200);
    assert.match(payload.mission.stop_condition, /run for 20 minutes, or stop early when proof is strong enough/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('mission run supports explicit whole-budget mode without manager jargon', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const run = runCli([
      'mission',
      'run',
      'fix the hvac dispatch handoff; use the whole 20 minutes',
      '--json',
    ], { cwd: dir });
    assert.equal(run.status, 0, run.stderr || run.stdout);

    const payload = JSON.parse(run.stdout);
    assert.equal(payload.budget_contract.policy, 'spend_full_budget');
    assert.equal(payload.budget_contract.requested_seconds, 1200);
    assert.equal(payload.budget_contract.plain_language, 'Use the whole time.');
    assert.match(payload.mission.stop_condition, /run for 20 minutes; use the whole time unless blocked or unsafe/);
    assert.match(payload.budget_contract.stop_rule, /keep picking the next useful move until time is up/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('mission run can plan and advance a validated child-goal chain', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const run = runCli([
      'mission',
      'run',
      'show me 3 or 4 goals done towards a novel mission that is validated and understandable',
      '--owner',
      'auto-improver',
      '--json',
    ], { cwd: dir });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    const payload = JSON.parse(run.stdout);
    const mission = payload.mission;

    assert.equal(mission.goal_chain.schema, 'atris.mission_goal_chain.v1');
    assert.equal(mission.goal_chain.target_count, 4);
    assert.equal(mission.goal_chain.done_count, 0);
    assert.equal(mission.goal_chain.goals.length, 4);
    assert.match(mission.goal_chain.pause_rule, /Pause when the chain has proof/);

    const statusBefore = runCli(['mission', 'status', mission.id], { cwd: dir });
    assert.equal(statusBefore.status, 0, statusBefore.stderr || statusBefore.stdout);
    assert.match(statusBefore.stdout, /goal chain: 0\/4 done/);

    ackNativeCodexGoal(dir, mission);
    let latest = mission;
    for (let index = 1; index <= 4; index += 1) {
      const tickArgs = [
        'mission',
        'tick',
        mission.id,
        '--summary',
        `goal ${index}: proof recorded for child goal ${index}`,
        '--json',
      ];
      if (index === 3) tickArgs.splice(6, 0, '--verify', 'node -e "process.exit(0)"');
      const tick = runCli(tickArgs, { cwd: dir });
      assert.equal(tick.status, 0, tick.stderr || tick.stdout);
      const tickPayload = JSON.parse(tick.stdout);
      latest = tickPayload.mission;
      assert.equal(latest.goal_chain.done_count, index);
      assert.equal(latest.goal_chain.goals[index - 1].status, 'done');
      if (index === 3) {
        assert.equal(tickPayload.verifier_result.passed, true);
        assert.equal(latest.status, 'running');
        assert.match(latest.next_action, /continue child goal 4/);
      }
    }

    assert.equal(latest.status, 'ready');
    assert.equal(latest.goal_chain.status, 'validated');
    assert.equal(latest.goal_chain.pause_ready, true);
    assert.match(latest.next_action, /mission feels good/);

    const status = runCli(['mission', 'status', mission.id], { cwd: dir });
    assert.equal(status.status, 0, status.stderr || status.stdout);
    assert.match(status.stdout, /goal chain: 4\/4 done/);
    assert.match(status.stdout, /\[x\] 4\. Explain the pause or next goal/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('mission run accepts one-word fuzzy intent as a new mission', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const run = runCli(['mission', 'run', 'improve', '--json'], { cwd: dir });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    const payload = JSON.parse(run.stdout);
    assert.equal(payload.action, 'mission_run_started');
    assert.equal(payload.mission.objective, 'improve');
    assert.equal(payload.mission.runner, 'codex_goal');
    assert.equal(payload.codex_goal_state.goal.objective, 'improve');
  } finally {
    cleanupTempDir(dir);
  }
});

test('mission run with atris2 runner writes Atris-owned goal state without Codex ack', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const run = runCli(['mission', 'run', 'ax fast visible goal', '--runner', 'atris2', '--json'], { cwd: dir });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    const payload = JSON.parse(run.stdout);
    assert.equal(payload.action, 'mission_run_started');
    assert.equal(payload.mission.runner, 'atris2');
    assert.equal(payload.mission.model, 'atris:fast');
    assert.equal(payload.requires_native_goal_start, false);
    assert.equal(payload.native_goal_action, null);
    assert.equal(payload.codex_goal_state, null);
    assert.equal(payload.atris_goal_state.action, 'atris_goal_candidate');
    assert.equal(payload.atris_goal_state.goal.objective, 'ax fast visible goal');
    assert.equal(payload.atris_goal_state.goal.runner, 'atris2');
    assert.equal(payload.atris_goal_state.goal.visible_goal.status, 'active');
    assert.equal(payload.atris_goal_state.goal.requires_native_goal_start, false);
    assert.equal(payload.atris_goal_state.goal.atris_tool_contract.blocked_without_platform_goal_write, false);
    assert.equal(fs.existsSync(path.join(dir, '.atris', 'state', 'atris_goal.json')), true);
    assert.equal(fs.existsSync(path.join(dir, 'atris', 'status', 'atris-goal.md')), true);

    const atrisGoal = runCli(['mission', 'goal', '--runtime', 'atris', '--json'], { cwd: dir });
    assert.equal(atrisGoal.status, 0, atrisGoal.stderr || atrisGoal.stdout);
    const atrisGoalPayload = JSON.parse(atrisGoal.stdout);
    assert.equal(atrisGoalPayload.action, 'atris_goal_candidate');
    assert.equal(atrisGoalPayload.goal.mission_id, payload.mission.id);
    assert.equal(atrisGoalPayload.goal.objective, 'ax fast visible goal');
    assert.equal(atrisGoalPayload.requires_native_goal_start, false);

    const codexGoal = runCli(['mission', 'goal', '--json'], { cwd: dir });
    assert.equal(codexGoal.status, 0, codexGoal.stderr || codexGoal.stdout);
    assert.equal(JSON.parse(codexGoal.stdout).action, 'no_goal_candidate');
  } finally {
    cleanupTempDir(dir);
  }
});

test('mission objective shorthand starts a visible-goal mission', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const run = runCli(['mission', 'fix', 'the', 'issue', '--json'], { cwd: dir });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    const payload = JSON.parse(run.stdout);
    assert.equal(payload.action, 'mission_run_started');
    assert.equal(payload.mission.objective, 'fix the issue');
    assert.equal(payload.mission.runner, 'codex_goal');
    assert.equal(payload.codex_goal_state.goal.objective, 'fix the issue');
    assert.equal(
      payload.codex_goal_state.goal.visible_goal.operations.refresh_on_phase_change,
      'atris mission goal --json before continuing changed work',
    );
    assert.match(payload.codex_goal_state.goal.codex_tool_contract.phase_change_refresh, /before changed follow-up work/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('remote-computer mission run preserves the local mission spine contract', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.atris'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.atris', 'business.json'), JSON.stringify({
      business_id: 'biz-remote-parity',
      workspace_id: 'ws-remote-parity',
      slug: 'remote-parity',
    }), 'utf8');

    const local = runCli([
      'mission',
      'run',
      'mission parity acceptance',
      '--owner',
      'mission-lead',
      '--runner',
      'codex_goal',
      '--verify',
      'node -e "process.exit(0)"',
      '--json',
    ], { cwd: dir });
    assert.equal(local.status, 0, local.stderr || local.stdout);
    const localPayload = JSON.parse(local.stdout);

    const remote = runCli([
      'mission',
      'run',
      'mission parity acceptance remote',
      '--owner',
      'mission-lead',
      '--runner',
      'atris2',
      '--verify',
      'node -e "process.exit(0)"',
      '--json',
    ], { cwd: dir });
    assert.equal(remote.status, 0, remote.stderr || remote.stdout);
    const remotePayload = JSON.parse(remote.stdout);

    assert.equal(localPayload.action, 'mission_run_started');
    assert.equal(remotePayload.action, 'mission_run_started');
    assert.equal(localPayload.mission.owner, remotePayload.mission.owner);
    assert.equal(localPayload.mission.lane, remotePayload.mission.lane);
    assert.equal(localPayload.mission.verifier, remotePayload.mission.verifier);
    assert.equal(remotePayload.mission.business_id, 'biz-remote-parity');
    assert.equal(remotePayload.mission.workspace_id, 'ws-remote-parity');
    assert.equal(remotePayload.mission.model, 'atris:fast');

    const localGoal = localPayload.codex_goal_state.goal;
    const remoteGoal = remotePayload.atris_goal_state.goal;
    assert.equal(localGoal.visible_goal.source, 'atris_mission');
    assert.equal(remoteGoal.visible_goal.source, 'atris_mission');
    assert.equal(localGoal.task_spine.schema, 'atris.mission_task_spine.v1');
    assert.equal(remoteGoal.task_spine.schema, 'atris.mission_task_spine.v1');
    assert.equal(localGoal.task_spine.owner, remoteGoal.task_spine.owner);
    assert.equal(localGoal.task_spine.lane, remoteGoal.task_spine.lane);
    assert.equal(localGoal.task_spine.has_task, false);
    assert.equal(remoteGoal.task_spine.has_task, false);
    assert.match(localGoal.task_spine.ensure_task_command, /atris mission attach-task/);
    assert.match(remoteGoal.task_spine.ensure_task_command, /atris mission attach-task/);
    assert.equal(localPayload.requires_native_goal_start, true);
    assert.equal(remotePayload.requires_native_goal_start, false);
    assert.equal(remoteGoal.atris_tool_contract.blocked_without_platform_goal_write, false);
  } finally {
    cleanupTempDir(dir);
  }
});

test('mission run --help prints help instead of starting a mission', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const run = runCli(['mission', 'run', '--help'], { cwd: dir });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    assert.equal(run.stderr, '');
    assert.match(run.stdout, /atris mission run/);
    assert.equal(fs.existsSync(path.join(dir, '.atris', 'state', 'missions.jsonl')), false);
  } finally {
    cleanupTempDir(dir);
  }
});

test('mission run accepts owner prefix before fuzzy intent', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris', 'team', 'validator'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'team', 'validator', 'MEMBER.md'), '# Validator\n', 'utf8');

    const run = runCli(['mission', 'run', 'validator', 'check proof', '--json'], { cwd: dir });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    const payload = JSON.parse(run.stdout);
    assert.equal(payload.action, 'mission_run_started');
    assert.equal(payload.mission.objective, 'check proof');
    assert.equal(payload.mission.owner, 'validator');
    assert.equal(payload.mission.owner_resolution, 'explicit_functional_owner');
  } finally {
    cleanupTempDir(dir);
  }
});

test('completed mission run seeds the next useful goal', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const run = runCli([
      'mission',
      'run',
      'ship fuzzy intent',
      '--owner',
      'mission-lead',
      '--verify',
      'node -e "process.exit(0)"',
      '--json',
    ], { cwd: dir });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    const started = JSON.parse(run.stdout);
    assert.equal(started.mission.started_from, 'mission_run_objective');
    assert.equal(started.mission.continue_on_complete, true);
    ackNativeCodexGoal(dir, started.mission);

    const tick = runCli(['mission', 'tick', started.mission.id, '--verify', '--complete-on-pass', '--json'], { cwd: dir });
    assert.equal(tick.status, 0, tick.stderr || tick.stdout);
    const payload = JSON.parse(tick.stdout);
    assert.equal(payload.mission.status, 'complete');
    assert.equal(payload.continuation_goal.inserted, true);
    assert.equal(payload.continuation_goal.mission.started_from, 'mission_run_continuation');
    assert.equal(payload.continuation_goal.mission.parent_mission_id, started.mission.id);
    assert.equal(
      payload.continuation_goal.mission.objective,
      'Decide and start the next useful mission after: ship fuzzy intent',
    );
    assert.equal(payload.codex_goal_state.action, 'codex_goal_candidate');
    assert.equal(payload.codex_goal_state.goal.mission_id, payload.continuation_goal.mission.id);
    assert.equal(payload.codex_goal_state.goal.objective, payload.continuation_goal.mission.objective);

    const goal = runCli(['mission', 'goal', '--json'], { cwd: dir });
    assert.equal(goal.status, 0, goal.stderr || goal.stdout);
    const goalPayload = JSON.parse(goal.stdout);
    assert.equal(goalPayload.action, 'codex_goal_candidate');
    assert.equal(goalPayload.goal.mission_id, payload.continuation_goal.mission.id);

    const next = runCli([
      'mission',
      'run',
      'make the next mission real',
      '--owner',
      'mission-lead',
      '--json',
    ], { cwd: dir });
    assert.equal(next.status, 0, next.stderr || next.stdout);
    const nextPayload = JSON.parse(next.stdout);
    assert.equal(nextPayload.mission.objective, 'make the next mission real');
    assert.equal(nextPayload.completed_continuation_goal.completed, true);
    assert.equal(nextPayload.completed_continuation_goal.mission.id, payload.continuation_goal.mission.id);
    assert.equal(nextPayload.completed_continuation_goal.mission.status, 'complete');
    assert.equal(nextPayload.completed_continuation_goal.mission.continued_by_mission_id, nextPayload.mission.id);
    assert.equal(nextPayload.codex_goal_state.goal.mission_id, nextPayload.mission.id);

    const continuationStatus = runCli(['mission', 'status', payload.continuation_goal.mission.id, '--json'], { cwd: dir });
    assert.equal(continuationStatus.status, 0, continuationStatus.stderr || continuationStatus.stdout);
    const continuationPayload = JSON.parse(continuationStatus.stdout);
    assert.equal(continuationPayload.missions[0].status, 'complete');
    assert.equal(continuationPayload.missions[0].continued_by_mission_id, nextPayload.mission.id);
  } finally {
    cleanupTempDir(dir);
  }
});

test('continuation mission chooses next mission instead of passing on inherited long-run verifier', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'atris', 'reports'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'reports', '2099-01-01-proof.md'), [
      '# Proof',
      '',
      'Suggested target: make the concrete follow-up real.',
      '',
    ].join('\n'), 'utf8');
    appendMissionState(dir, {
      id: 'mission-choice-continuation',
      slug: 'mission-choice-continuation',
      objective: 'Decide and start the next useful mission after: work overnight and self improve goal after goal',
      status: 'planning',
      runner: 'codex_goal',
      verifier: '',
      started_from: 'mission_run_continuation',
      continuation_policy: 'choose_next_mission',
      parent_mission_id: 'mission-parent',
      parent_objective: 'work overnight and self improve goal after goal',
      native_goal_ack: {
        runtime: 'codex',
        status: 'active',
        objective: 'Decide and start the next useful mission after: work overnight and self improve goal after goal',
      },
      created_at: '2026-06-30T12:00:00.000Z',
      updated_at: '2026-06-30T12:00:00.000Z',
    });

    const status = runCli(['mission', 'status', 'mission-choice-continuation', '--json'], { cwd: dir });
    assert.equal(status.status, 0, status.stderr || status.stdout);
    const statusPayload = JSON.parse(status.stdout);
    assert.equal(statusPayload.missions[0].verifier, '');
    assert.equal(statusPayload.missions[0].effective_verifier, undefined);
    assert.equal(statusPayload.missions[0].next_action, 'next move');

    const due = runCli(['mission', 'run', '--due', '--no-claude', '--max-ticks', '1', '--complete-on-pass', '--json'], { cwd: dir });
    assert.equal(due.status, 0, due.stderr || due.stdout);
    assert.deepEqual(JSON.parse(due.stdout), {
      ok: true,
      action: 'run_skipped',
      reason: 'no_due_mission',
      mission: null,
    });

    const attached = runCli(['mission', 'attach-task', 'mission-choice-continuation', '--json'], { cwd: dir });
    assert.equal(attached.status, 0, attached.stderr || attached.stdout);
    const attachedPayload = JSON.parse(attached.stdout);
    assert.match(attachedPayload.mission.next_action, /atris mission run 'Make the concrete follow-up real' --owner mission-lead/);
    assert.doesNotMatch(attachedPayload.mission.next_action, /<next useful mission>/);

    const ack = ackNativeCodexGoal(dir, attachedPayload.mission);
    assert.equal(ack.codex_goal_state.goal.visible_goal.status, 'active');
    assert.match(ack.codex_goal_state.goal.next_command, /atris mission run 'Make the concrete follow-up real' --owner mission-lead/);
    assert.doesNotMatch(ack.codex_goal_state.goal.next_command, /<next useful mission>/);

    const next = runCli(['mission', 'run', 'Make the concrete follow-up real', '--owner', 'mission-lead', '--json'], { cwd: dir });
    assert.equal(next.status, 0, next.stderr || next.stdout);
    const nextPayload = JSON.parse(next.stdout);
    assert.equal(nextPayload.mission.objective, 'Make the concrete follow-up real');
    assert.equal(nextPayload.completed_continuation_goal.completed, true);
    assert.equal(nextPayload.completed_continuation_goal.mission.id, 'mission-choice-continuation');
    assert.equal(nextPayload.completed_continuation_goal.mission.continued_by_mission_id, nextPayload.mission.id);
  } finally {
    cleanupTempDir(dir);
  }
});

test('continuation mission includes member value preview before starting next mission', { skip: !hasNodeSqlite() && 'node:sqlite unavailable' }, () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'ROADMAP.md'), [
      '# Roadmap',
      '',
      '## Open loop items',
      '',
      '- [ ] Ship ax connector turn isolation and Gmail receipt previews',
      '',
    ].join('\n'), 'utf8');
    appendMissionState(dir, {
      id: 'mission-choice-preview',
      slug: 'mission-choice-preview',
      owner: 'researcher',
      objective: 'Decide and start the next useful mission after: run awake loop with member taste',
      status: 'planning',
      runner: 'codex_goal',
      verifier: '',
      started_from: 'mission_run_continuation',
      continuation_policy: 'choose_next_mission',
      parent_mission_id: 'mission-parent',
      parent_objective: 'run awake loop with member taste',
      native_goal_ack: {
        runtime: 'codex',
        status: 'active',
        objective: 'Decide and start the next useful mission after: run awake loop with member taste',
      },
      created_at: '2026-06-30T12:00:00.000Z',
      updated_at: '2026-06-30T12:00:00.000Z',
    });

    const attached = runCli(['mission', 'attach-task', 'mission-choice-preview', '--json'], { cwd: dir });
    assert.equal(attached.status, 0, attached.stderr || attached.stdout);
    const attachedPayload = JSON.parse(attached.stdout);
    assert.match(attachedPayload.mission.next_action, /atris mission run 'Ship ax connector turn isolation and Gmail receipt previews' --owner researcher/);
    assert.equal(attachedPayload.mission.next_action_preview.schema, 'atris.mission_value_preview.v1');
    assert.equal(attachedPayload.mission.next_action_preview.profile.id, 'technical_homerun');
    assert.equal(
      attachedPayload.mission.next_action_preview.feynman.what,
      'Make ax safer with Gmail: keep each chat request separate, and show a clear preview or receipt before Gmail actions.',
    );
    assert.match(attachedPayload.mission.next_action_preview.feynman.why_now, /technical bet/);
    assert.match(attachedPayload.mission.next_action_preview.feynman.validation, /before\/after receipt/);

    const ack = ackNativeCodexGoal(dir, attachedPayload.mission);
    assert.equal(ack.codex_goal_state.goal.next_action_preview.feynman.what, attachedPayload.mission.next_action_preview.feynman.what);

    const status = runCli(['mission', 'status', 'mission-choice-preview'], { cwd: dir });
    assert.equal(status.status, 0, status.stderr || status.stdout);
    assert.match(status.stdout, /preview: Make ax safer with Gmail/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('continuation mission uses taste memory and recent logs when scoring next mission', { skip: !hasNodeSqlite() && 'node:sqlite unavailable' }, () => {
  const dir = makeTempDir();
  const previousDb = process.env.ATRIS_TASKS_DB;
  let taskDb = null;
  try {
    const taskDbPath = path.join(dir, '.atris', 'tasks.db');
    process.env.ATRIS_TASKS_DB = taskDbPath;
    taskDb = require('../lib/task-db');
    taskDb.close();

    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'atris', 'team', 'auto-improver', 'logs'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'atris', 'logs', '2026'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'ROADMAP.md'), [
      '# Roadmap',
      '',
      '## Open loop items',
      '',
      '- [ ] Build compiler benchmark harness',
      '- [ ] Ship onboarding proof preview for customer demo',
      '',
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(dir, 'atris', 'thinking.md'), [
      '# thinking.md',
      '',
      '- 30 days of runway means prefer user/revenue proof over clever work.',
      '- Everything should be plain English and easy to understand.',
      '- Proof and receipts matter before accept.',
      '',
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(dir, 'atris', 'team', 'auto-improver', 'MISSION.md'), [
      '# Auto-Improver Mission',
      '',
      '- Prevent repeated token waste.',
      '- Keep technical work only when it creates visible proof.',
      '',
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(dir, 'atris', 'logs', '2026', '2026-07-01.md'), [
      '# 2026-07-01',
      '',
      '- Recent logs are working memory: focus on demo-ready proof and users.',
      '',
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(dir, 'atris', 'team', 'auto-improver', 'logs', '2026-07-01.md'), [
      '# 2026-07-01',
      '',
      '- Working memory: do not waste tokens; simplify the next preview.',
      '',
    ].join('\n'), 'utf8');
    const db = taskDb.open();
    const acceptedTask = taskDb.addTask(db, {
      title: 'Accepted demo proof path',
      status: 'done',
      tag: 'taste',
      workspaceRoot: taskDb.workspaceRoot(dir),
    });
    taskDb.reviewTask(db, {
      id: acceptedTask.id,
      actor: 'keshav',
      reward: 1,
      proof: 'Plain customer demo proof was accepted.',
    });
    const revisedTask = taskDb.addTask(db, {
      title: 'Rejected jargon plan',
      status: 'review',
      claimedBy: 'auto-improver',
      tag: 'taste',
      workspaceRoot: taskDb.workspaceRoot(dir),
    });
    taskDb.reviseTask(db, {
      id: revisedTask.id,
      actor: 'keshav',
      note: 'Too much jargon; explain in simple terms first.',
    });
    appendMissionState(dir, {
      id: 'mission-choice-memory',
      slug: 'mission-choice-memory',
      owner: 'auto-improver',
      objective: 'Decide and start the next useful mission after: use taste memory',
      status: 'planning',
      runner: 'codex_goal',
      verifier: '',
      started_from: 'mission_run_continuation',
      continuation_policy: 'choose_next_mission',
      parent_mission_id: 'mission-parent',
      parent_objective: 'use taste memory',
      native_goal_ack: {
        runtime: 'codex',
        status: 'active',
        objective: 'Decide and start the next useful mission after: use taste memory',
      },
      created_at: '2026-06-30T12:00:00.000Z',
      updated_at: '2026-06-30T12:00:00.000Z',
    });

    const attached = runCli(['mission', 'attach-task', 'mission-choice-memory', '--json'], { cwd: dir, env: { ATRIS_TASKS_DB: taskDbPath } });
    assert.equal(attached.status, 0, attached.stderr || attached.stdout);
    const payload = JSON.parse(attached.stdout);
    assert.match(payload.mission.next_action, /atris mission run 'Ship onboarding proof preview for customer demo' --owner auto-improver/);
    const preview = payload.mission.next_action_preview;
    assert.equal(preview.taste_memory.schema, 'atris.mission_taste_memory.v1');
    assert.equal(preview.taste_memory.sources.thinking_md.present, true);
    assert.equal(preview.taste_memory.sources.member_mission.present, true);
    assert.equal(preview.taste_memory.sources.recent_logs.length, 2);
    assert.equal(preview.taste_memory.sources.task_history.accepted.length, 1);
    assert.equal(preview.taste_memory.sources.task_history.revised.length, 1);
    assert(preview.score.memory_boost > 0);
    assert(preview.taste_memory.signals.some((signal) => signal.id === 'working_memory'));
    assert.match(preview.feynman.why_now, /Taste memory says:/);
    assert.match(preview.feynman.taste, /runway|plain-English|proof|working memory/i);
  } finally {
    if (taskDb) taskDb.close();
    if (previousDb === undefined) delete process.env.ATRIS_TASKS_DB;
    else process.env.ATRIS_TASKS_DB = previousDb;
    cleanupTempDir(dir);
  }
});

test('continuation mission stops instead of returning placeholder when no concrete next mission exists', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    appendMissionState(dir, {
      id: 'mission-choice-empty',
      slug: 'mission-choice-empty',
      objective: 'Decide and start the next useful mission after: finish an empty long run',
      status: 'planning',
      runner: 'codex_goal',
      verifier: '',
      started_from: 'mission_run_continuation',
      continuation_policy: 'choose_next_mission',
      parent_mission_id: 'mission-parent-empty',
      parent_objective: 'finish an empty long run',
      native_goal_ack: {
        runtime: 'codex',
        status: 'active',
        objective: 'Decide and start the next useful mission after: finish an empty long run',
      },
      created_at: '2026-06-30T12:00:00.000Z',
      updated_at: '2026-06-30T12:00:00.000Z',
    });

    const attached = runCli(['mission', 'attach-task', 'mission-choice-empty', '--json'], { cwd: dir });
    assert.equal(attached.status, 0, attached.stderr || attached.stdout);
    const attachedPayload = JSON.parse(attached.stdout);
    assert.match(attachedPayload.mission.next_action, /atris mission stop mission-choice-empty --reason 'no concrete follow-up mission found in Atris state' --json/);
    assert.doesNotMatch(attachedPayload.mission.next_action, /<next useful mission>/);

    const ack = ackNativeCodexGoal(dir, attachedPayload.mission);
    assert.match(ack.codex_goal_state.goal.next_command, /atris mission stop mission-choice-empty --reason 'no concrete follow-up mission found in Atris state' --json/);
    assert.doesNotMatch(ack.codex_goal_state.goal.next_command, /<next useful mission>/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('continuation mission skips report target that was already handled', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris', 'reports'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'reports', '2099-01-01-proof.md'), [
      '# Proof',
      '',
      'Suggested target: repeat done thing.',
      '',
    ].join('\n'), 'utf8');
    appendMissionState(dir, {
      id: 'mission-repeat-done-thing',
      slug: 'mission-repeat-done-thing',
      objective: 'Repeat done thing',
      status: 'complete',
      runner: 'codex_goal',
      verifier: '',
      created_at: '2026-06-30T11:00:00.000Z',
      updated_at: '2026-06-30T11:05:00.000Z',
      completed_at: '2026-06-30T11:05:00.000Z',
    });
    appendMissionState(dir, {
      id: 'mission-choice-handled-report',
      slug: 'mission-choice-handled-report',
      objective: 'Decide and start the next useful mission after: finish handled report',
      status: 'planning',
      runner: 'codex_goal',
      verifier: '',
      started_from: 'mission_run_continuation',
      continuation_policy: 'choose_next_mission',
      parent_mission_id: 'mission-parent-handled-report',
      parent_objective: 'finish handled report',
      native_goal_ack: {
        runtime: 'codex',
        status: 'active',
        objective: 'Decide and start the next useful mission after: finish handled report',
      },
      created_at: '2026-06-30T12:00:00.000Z',
      updated_at: '2026-06-30T12:00:00.000Z',
    });

    const attached = runCli(['mission', 'attach-task', 'mission-choice-handled-report', '--json'], { cwd: dir });
    assert.equal(attached.status, 0, attached.stderr || attached.stdout);
    const attachedPayload = JSON.parse(attached.stdout);
    assert.match(attachedPayload.mission.next_action, /atris mission stop mission-choice-handled-report --reason 'no concrete follow-up mission found in Atris state' --json/);
    assert.doesNotMatch(attachedPayload.mission.next_action, /Repeat done thing/);

    const ack = ackNativeCodexGoal(dir, attachedPayload.mission);
    assert.match(ack.codex_goal_state.goal.next_command, /atris mission stop mission-choice-handled-report --reason 'no concrete follow-up mission found in Atris state' --json/);
    assert.doesNotMatch(ack.codex_goal_state.goal.next_command, /Repeat done thing/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('continuation mission skips report target that already exists as ready work', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris', 'reports'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'reports', '2099-01-02-proof.md'), [
      '# Proof',
      '',
      'Suggested target: repeat active thing.',
      '',
    ].join('\n'), 'utf8');
    appendMissionState(dir, {
      id: 'mission-repeat-active-thing',
      slug: 'mission-repeat-active-thing',
      objective: 'Repeat active thing',
      status: 'ready',
      runner: 'codex_goal',
      verifier: '',
      created_at: '2026-06-30T11:00:00.000Z',
      updated_at: '2026-06-30T11:05:00.000Z',
    });
    appendMissionState(dir, {
      id: 'mission-choice-active-report',
      slug: 'mission-choice-active-report',
      objective: 'Decide and start the next useful mission after: finish active report',
      status: 'planning',
      runner: 'codex_goal',
      verifier: '',
      started_from: 'mission_run_continuation',
      continuation_policy: 'choose_next_mission',
      parent_mission_id: 'mission-parent-active-report',
      parent_objective: 'finish active report',
      native_goal_ack: {
        runtime: 'codex',
        status: 'active',
        objective: 'Decide and start the next useful mission after: finish active report',
      },
      created_at: '2026-06-30T12:00:00.000Z',
      updated_at: '2026-06-30T12:00:00.000Z',
    });

    const attached = runCli(['mission', 'attach-task', 'mission-choice-active-report', '--json'], { cwd: dir });
    assert.equal(attached.status, 0, attached.stderr || attached.stdout);
    const attachedPayload = JSON.parse(attached.stdout);
    assert.match(attachedPayload.mission.next_action, /atris mission stop mission-choice-active-report --reason 'no concrete follow-up mission found in Atris state' --json/);
    assert.doesNotMatch(attachedPayload.mission.next_action, /Repeat active thing/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('bare mission run asks for input instead of resuming an old mission', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    startMission(dir, 'old saved mission');

    const run = runCli(['mission', 'run', '--json'], { cwd: dir });
    assert.equal(run.status, 1);
    assert.equal(run.stderr, '');
    const payload = JSON.parse(run.stdout);
    assert.equal(payload.ok, false);
    assert.equal(payload.action, 'mission_input_required');
    assert.equal(payload.prompt, 'What mission should Atris run?');
    assert.equal(payload.owner, 'mission-lead');
    assert.equal(payload.owner_prompt, 'Which team member should own it?');
    assert.match(payload.example, /atris mission run "make onboarding magical"/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('mission run with owner only asks for the missing mission', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris', 'team', 'mission-lead'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'team', 'mission-lead', 'MEMBER.md'), '# Mission Lead\n', 'utf8');

    const run = runCli(['mission', 'run', 'mission-lead', '--json'], { cwd: dir });
    assert.equal(run.status, 1);
    const payload = JSON.parse(run.stdout);
    assert.equal(payload.action, 'mission_input_required');
    assert.equal(payload.owner, 'mission-lead');
    assert.match(payload.example, /--owner mission-lead/);
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

test('mission run --due selects acknowledged always-on caller-session missions without verifier', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    appendMissionState(dir, {
      id: 'newer-unacked-codex-loop',
      slug: 'newer-unacked-codex-loop',
      objective: 'newer unacked codex loop',
      status: 'planning',
      runner: 'codex_goal',
      verifier: '',
      always_on: true,
      cadence: '13m',
      xp_task_enabled: true,
      task_ids: ['task-unacked'],
      task_id: 'task-unacked',
      task_ref: 'CLI-U',
      created_at: '2026-05-03T00:00:00.000Z',
      updated_at: '2026-05-03T00:00:00.000Z',
    });
    appendMissionState(dir, {
      id: 'acked-codex-loop',
      slug: 'acked-codex-loop',
      objective: 'acked codex loop',
      status: 'planning',
      runner: 'codex_goal',
      verifier: '',
      always_on: true,
      cadence: '13m',
      xp_task_enabled: true,
      task_ids: ['task-acked'],
      task_id: 'task-acked',
      task_ref: 'CLI-A',
      native_goal_ack: {
        runtime: 'codex',
        status: 'active',
        objective: 'acked codex loop',
        acknowledged_at: '2026-05-02T00:01:00.000Z',
      },
      created_at: '2026-05-02T00:00:00.000Z',
      updated_at: '2026-05-02T00:00:00.000Z',
    });

    const due = selectDueMission(dir);
    assert.equal(due.id, 'acked-codex-loop');

    const run = runCli(['mission', 'run', '--due', '--no-claude', '--no-drain', '--max-ticks', '1', '--json'], { cwd: dir });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    const payload = JSON.parse(run.stdout);
    assert.equal(payload.action, 'mission_run');
    assert.equal(payload.mission.id, 'acked-codex-loop');
    assert.equal(payload.mission.status, 'running');
    assert.equal(payload.mission.next_action, 'next move: run atris mission run acked-codex-loop');
    assert.equal(payload.ticks[0].reason, 'caller-session-runner');
    assert.equal(payload.ticks[0].verifier_passed, undefined);
  } finally {
    cleanupTempDir(dir);
  }
});

test('mission tick keeps task-backed always-on caller-session missions runnable without verifier', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    appendMissionState(dir, {
      id: 'acked-codex-loop',
      slug: 'acked-codex-loop',
      objective: 'acked codex loop',
      status: 'running',
      runner: 'codex_goal',
      verifier: '',
      always_on: true,
      cadence: '13m',
      xp_task_enabled: true,
      task_ids: ['task-acked'],
      task_id: 'task-acked',
      task_ref: 'CLI-A',
      native_goal_ack: {
        runtime: 'codex',
        status: 'active',
        objective: 'acked codex loop',
        acknowledged_at: '2026-05-02T00:01:00.000Z',
      },
      created_at: '2026-05-02T00:00:00.000Z',
      updated_at: '2026-05-02T00:00:00.000Z',
    });

    const tick = runCli(['mission', 'tick', 'acked-codex-loop', '--summary', 'recorded useful progress', '--json'], { cwd: dir });
    assert.equal(tick.status, 0, tick.stderr || tick.stdout);
    const payload = JSON.parse(tick.stdout);
    assert.equal(payload.action, 'mission_tick');
    assert.equal(payload.mission.status, 'running');
    assert.equal(payload.mission.next_action, 'next move: run atris mission run acked-codex-loop');
  } finally {
    cleanupTempDir(dir);
  }
});

test('explicit caller-session mission run exits after one recorded tick', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    appendMissionState(dir, {
      id: 'explicit-codex-loop',
      slug: 'explicit-codex-loop',
      objective: 'explicit codex loop',
      status: 'paused',
      runner: 'codex_goal',
      verifier: 'node -e "process.exit(0)"',
      always_on: true,
      cadence: '13m',
      xp_task_enabled: true,
      task_ids: ['task-explicit'],
      task_id: 'task-explicit',
      task_ref: 'CLI-X',
      native_goal_ack: {
        runtime: 'codex',
        status: 'active',
        objective: 'explicit codex loop',
        acknowledged_at: '2026-05-02T00:01:00.000Z',
      },
      paused_at: '2026-05-02T00:02:00.000Z',
      stop_reason: 'aborted',
      created_at: '2026-05-02T00:00:00.000Z',
      updated_at: '2026-05-02T00:00:00.000Z',
    });

    const run = runCli(['mission', 'run', 'explicit-codex-loop', '--no-drain', '--json'], { cwd: dir });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    assert.equal(run.stderr, '');
    const payload = JSON.parse(run.stdout);
    assert.equal(payload.action, 'mission_run');
    assert.equal(payload.ran_ticks, 1);
    assert.equal(payload.tick_count, 1);
    assert.equal(payload.pause_reason, null);
    assert.equal(payload.mission.status, 'ready');
    assert.equal(payload.mission.paused_at, null);
    assert.equal(payload.mission.stop_reason, null);
    assert.match(payload.mission.resumed_at, /^20/);
    assert.equal(payload.mission.next_action, 'next move: run atris mission run explicit-codex-loop');
    assert.equal(payload.ticks[0].reason, 'caller-session-runner');
    assert.equal(payload.ticks[0].verifier_passed, true);
    assert.equal(fs.existsSync(path.join(dir, '.atris', 'state', 'mission-explicit-codex-loop.lock')), false);

    const humanRun = runCli(['mission', 'run', 'explicit-codex-loop', '--no-drain'], { cwd: dir });
    assert.equal(humanRun.status, 0, humanRun.stderr || humanRun.stdout);
    assert.match(humanRun.stdout, /Changed: Recorded a proof heartbeat for this always-on mission\./);
    assert.doesNotMatch(humanRun.stdout, /Changed: explicit codex loop is ready for review\./);
  } finally {
    cleanupTempDir(dir);
  }
});

test('mission run landing points to self-improvement seed when no task is queued', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    appendMissionState(dir, {
      id: 'seeded-codex-loop',
      slug: 'seeded-codex-loop',
      objective: 'seeded codex loop',
      status: 'ready',
      runner: 'codex_goal',
      verifier: 'node -e "process.exit(0)"',
      always_on: true,
      cadence: '13m',
      xp_task_enabled: false,
      native_goal_ack: {
        runtime: 'codex',
        status: 'active',
        objective: 'seeded codex loop',
        acknowledged_at: '2026-05-02T00:01:00.000Z',
      },
      created_at: '2026-05-02T00:00:00.000Z',
      updated_at: '2026-05-02T00:00:00.000Z',
    });

    const run = runCli(['mission', 'run', 'seeded-codex-loop', '--no-drain'], { cwd: dir });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    assert.match(run.stdout, /Next: Create the next proof-backed self-improvement task\./);
    assert.doesNotMatch(run.stdout, /Next: Run the next proof step\./);
  } finally {
    cleanupTempDir(dir);
  }
});

test('mission run landing uses evidence-backed self-improvement target', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris', 'reports'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'reports', '2099-01-01-proof.md'), [
      '# Proof',
      '',
      'Suggested target: add a command that creates and claims the suggested self-improvement task from the loop seed.',
      '',
    ].join('\n'), 'utf8');
    appendMissionState(dir, {
      id: 'evidence-codex-loop',
      slug: 'evidence-codex-loop',
      objective: 'evidence codex loop',
      status: 'ready',
      runner: 'codex_goal',
      verifier: 'node -e "process.exit(0)"',
      always_on: true,
      cadence: '13m',
      xp_task_enabled: false,
      native_goal_ack: {
        runtime: 'codex',
        status: 'active',
        objective: 'evidence codex loop',
        acknowledged_at: '2026-05-02T00:01:00.000Z',
      },
      created_at: '2026-05-02T00:00:00.000Z',
      updated_at: '2026-05-02T00:00:00.000Z',
    });

    const run = runCli(['mission', 'run', 'evidence-codex-loop', '--no-drain'], { cwd: dir });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    assert.match(run.stdout, /Next: Add a command that creates and claims the suggested self-improvement task from the loop seed\./);
    assert.doesNotMatch(run.stdout, /Next: Run the next proof step\./);
  } finally {
    cleanupTempDir(dir);
  }
});

test('mission run --create-next materializes the evidence-backed task', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris', 'reports'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'reports', '2099-01-01-proof.md'), [
      '# Proof',
      '',
      'Suggested target: add mission run create-next so a heartbeat can materialize the suggested loop task.',
      '',
    ].join('\n'), 'utf8');
    appendMissionState(dir, {
      id: 'create-next-codex-loop',
      slug: 'create-next-codex-loop',
      objective: 'create next codex loop',
      status: 'ready',
      runner: 'codex_goal',
      verifier: 'node -e "process.exit(0)"',
      always_on: true,
      cadence: '13m',
      xp_task_enabled: false,
      native_goal_ack: {
        runtime: 'codex',
        status: 'active',
        objective: 'create next codex loop',
        acknowledged_at: '2026-05-02T00:01:00.000Z',
      },
      created_at: '2026-05-02T00:00:00.000Z',
      updated_at: '2026-05-02T00:00:00.000Z',
    });

    const run = runCli(['mission', 'run', 'create-next-codex-loop', '--no-drain', '--create-next'], { cwd: dir });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    const projection = JSON.parse(fs.readFileSync(path.join(dir, '.atris', 'state', 'tasks.projection.json'), 'utf8'));
    const task = projection.tasks.find((row) => row.title === 'Add mission run create-next so a heartbeat can materialize the suggested loop task');
    assert.ok(task);
    assert.ok(
      run.stdout.includes(`Changed: Created and claimed next task: ${task.display_id} ${task.title}.`),
      run.stdout,
    );
    assert.ok(
      run.stdout.includes(`Next: Created next task: ${task.display_id} ${task.title}.`),
      run.stdout,
    );
    const receipt = readSummaryReceipt(dir, run.stdout);
    assert.equal(receipt.result?.created_next?.ok, true);
    assert.equal(receipt.result?.created_next?.task?.display_id, task.display_id);
    assert.equal(receipt.result?.landing?.changed, `Created and claimed next task: ${task.display_id} ${task.title}.`);
    assert.equal(receipt.result?.landing?.timeline_command, 'atris mission timeline create-next-codex-loop --limit 5');
    assert.equal(receipt.result?.landing?.export_command, 'atris mission timeline create-next-codex-loop --all --write');
    assert.equal(receipt.result?.landing?.prune_preview_command, 'atris mission timeline create-next-codex-loop --prune-preview');
    assert.equal(receipt.result?.landing?.next, `Created next task: ${task.display_id} ${task.title}.`);
    assert.equal(task?.status, 'claimed');
    assert.equal(task?.claimed_by, 'mission-lead');
  } finally {
    cleanupTempDir(dir);
  }
});

test('mission run --create-next names the active task when duplicate protection skips creation', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris', 'reports'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'reports', '2099-01-01-proof.md'), [
      '# Proof',
      '',
      'Suggested target: show the active task in mission run create-next landing when duplicate protection skips creation.',
      '',
    ].join('\n'), 'utf8');
    appendMissionState(dir, {
      id: 'create-next-active-codex-loop',
      slug: 'create-next-active-codex-loop',
      objective: 'create next active codex loop',
      status: 'ready',
      runner: 'codex_goal',
      verifier: 'node -e "process.exit(0)"',
      always_on: true,
      cadence: '13m',
      xp_task_enabled: false,
      native_goal_ack: {
        runtime: 'codex',
        status: 'active',
        objective: 'create next active codex loop',
        acknowledged_at: '2026-05-02T00:01:00.000Z',
      },
      created_at: '2026-05-02T00:00:00.000Z',
      updated_at: '2026-05-02T00:00:00.000Z',
    });

    const created = runCli(['loop', 'create-next', '--as', 'auto-improver', '--json'], { cwd: dir });
    assert.equal(created.status, 0, created.stderr || created.stdout);
    const task = JSON.parse(created.stdout).task;

    const run = runCli(['mission', 'run', 'create-next-active-codex-loop', '--no-drain', '--create-next'], { cwd: dir });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    assert.ok(
      run.stdout.includes(`Changed: Kept active task: ${task.display_id} ${task.title}. No duplicate was created.`),
      run.stdout,
    );
    assert.ok(
      run.stdout.includes(`Next: Continue active task: ${task.display_id} ${task.title}.`),
      run.stdout,
    );
    const receipt = readSummaryReceipt(dir, run.stdout);
    assert.equal(receipt.result?.created_next?.reason, 'active_task');
    assert.equal(receipt.result?.created_next?.move?.ref, task.display_id);
    assert.equal(receipt.result?.landing?.changed, `Kept active task: ${task.display_id} ${task.title}. No duplicate was created.`);
    assert.equal(receipt.result?.landing?.timeline_command, 'atris mission timeline create-next-active-codex-loop --limit 5');
    assert.equal(receipt.result?.landing?.export_command, 'atris mission timeline create-next-active-codex-loop --all --write');
    assert.equal(receipt.result?.landing?.prune_preview_command, 'atris mission timeline create-next-active-codex-loop --prune-preview');
    assert.equal(receipt.result?.landing?.next, `Continue active task: ${task.display_id} ${task.title}.`);

    const projection = JSON.parse(fs.readFileSync(path.join(dir, '.atris', 'state', 'tasks.projection.json'), 'utf8'));
    assert.equal(projection.tasks.filter((row) => row.title === task.title).length, 1);
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

test('mission run --due skips blocked caller-session missions', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    appendMissionState(dir, {
      id: 'old-codex-due',
      slug: 'old-codex-due',
      objective: 'old codex due mission',
      status: 'running',
      runner: 'codex_goal',
      verifier: 'true',
      created_at: '2026-05-01T00:00:00.000Z',
      updated_at: '2026-05-01T00:00:00.000Z',
    });
    appendMissionState(dir, {
      id: 'current-codex-due',
      slug: 'current-codex-due',
      objective: 'current codex due mission',
      status: 'blocked',
      runner: 'codex_goal',
      verifier: 'true',
      created_at: '2026-05-02T00:00:00.000Z',
      updated_at: '2026-05-02T00:00:00.000Z',
    });

    const due = selectDueMission(dir);
    assert.equal(due.id, 'old-codex-due');
  } finally {
    cleanupTempDir(dir);
  }
});

test('mission run --due skips human-gated verifier missions', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    appendMissionState(dir, {
      id: 'old-agent-due',
      slug: 'old-agent-due',
      objective: 'old agent due mission',
      status: 'running',
      runner: 'codex_goal',
      verifier: 'true',
      created_at: '2026-05-01T00:00:00.000Z',
      updated_at: '2026-05-01T00:00:00.000Z',
    });
    appendMissionState(dir, {
      id: 'current-human-gated',
      slug: 'current-human-gated',
      objective: 'current human gated mission',
      status: 'ready',
      runner: 'codex_goal',
      verifier: 'true',
      human_asks: ['Keshav approves publish voice and title'],
      created_at: '2026-05-02T00:00:00.000Z',
      updated_at: '2026-05-02T00:00:00.000Z',
    });

    const due = selectDueMission(dir);
    assert.equal(due.id, 'old-agent-due');
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
    assert.equal(payload.goal.objective, 'codex visible goal mission');
    assert.match(payload.goal.next_command, /create_goal/);
    assert.match(payload.goal.next_command, new RegExp(`mission goal ack ${mission.id}`));
    assert.equal(payload.requires_native_goal_start, true);
    assert.equal(payload.native_goal_action.tool, 'create_goal');
    assert.equal(payload.goal.requires_native_goal_start, true);
    assert.equal(payload.goal.native_goal_action.args.objective, 'codex visible goal mission');
    assert.equal(payload.goal.task_spine.has_task, false);
    assert.equal(payload.goal.task_spine.ensure_task_command, `atris mission attach-task ${mission.id} --json`);
    assert.match(payload.goal.replace_after, /replace the Codex \/goal/);
    assert.equal(payload.goal.visible_goal.schema, 'atris.visible_chat_goal_bridge.v1');
    assert.equal(payload.goal.visible_goal.runtime, 'codex');
    assert.equal(payload.goal.visible_goal.source, 'atris_mission');
    assert.equal(payload.goal.visible_goal.mission_id, mission.id);
    assert.equal(payload.goal.visible_goal.desired_objective, payload.goal.objective);
    assert.equal(payload.goal.visible_goal.status, 'needs_runtime_write');
    assert.equal(payload.goal.visible_goal.operations.read_current_goal, 'get_goal');
    assert.equal(
      payload.goal.visible_goal.operations.create_when_empty_or_completed,
      'create_goal({ objective: goal.objective })',
    );
    assert.equal(
      payload.goal.visible_goal.operations.ack_after_create,
      `atris mission goal ack ${mission.id} --runtime codex --status active --objective 'codex visible goal mission' --json`,
    );
    assert.equal(
      payload.goal.visible_goal.operations.complete_after_proof,
      'update_goal({ status: "complete" })',
    );
    assert.equal(payload.goal.visible_goal.operations.refresh_next_candidate, 'atris mission goal --json');
    assert.deepEqual(payload.goal.codex_tool_contract, {
      current_policy: 'keep one visible Codex /goal active for the selected Atris mission',
      read_current_goal: 'get_goal',
      complete_current_goal: 'update_goal({ status: "complete" })',
      select_next_goal: 'atris mission goal --json',
      set_next_goal: 'use goal.visible_goal: create_goal({ objective: goal.objective }) when no active goal blocks the slot',
      visible_goal_bridge: 'goal.visible_goal',
      platform_requirement: 'Codex runtime must expose replace_goal/set_goal, or allow update_goal({ status: "complete" }) followed by create_goal({ objective }).',
      phase_change_refresh: 'before changed follow-up work, run atris mission goal --json and mirror the returned visible goal',
      runtime_tool_sequence: 'get_goal -> create_goal({ objective }) -> atris mission goal ack <mission-id> --runtime codex --status active --objective "<objective>" --json -> do work -> update_goal({ status: "complete" }) after proof or phase change -> atris mission goal --json',
      blocked_without_platform_goal_write: true,
      mission_id: mission.id,
    });
    const state = JSON.parse(fs.readFileSync(payload.state_path, 'utf8'));
    assert.equal(state.schema, 'atris.codex_goal_controller.v1');
    assert.equal(state.action, 'codex_goal_candidate');
    assert.equal(state.goal.mission_id, mission.id);
    const status = fs.readFileSync(payload.status_path, 'utf8');
    assert.match(status, /Codex Goal Controller/);
    assert.match(status, /visible goal: needs_runtime_write/);
    assert.match(status, /visible goal create: create_goal\(\{ objective: goal\.objective \}\)/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('mission goal skips human-gated ready missions', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    appendMissionState(dir, {
      id: 'older-codex-work',
      slug: 'older-codex-work',
      objective: 'older executable codex mission',
      status: 'running',
      runner: 'codex_goal',
      verifier: 'true',
      created_at: '2026-05-01T00:00:00.000Z',
      updated_at: '2026-05-01T00:00:00.000Z',
    });
    appendMissionState(dir, {
      id: 'new-human-review',
      slug: 'new-human-review',
      objective: 'new human review mission',
      status: 'ready',
      runner: 'codex_goal',
      verifier: 'true',
      human_asks: ['Keshav approves publish voice and title'],
      created_at: '2026-05-02T00:00:00.000Z',
      updated_at: '2026-05-02T00:00:00.000Z',
    });

    const selected = selectCodexGoalMission(dir);
    assert.equal(selected.mission.id, 'older-codex-work');

    const goal = runCli(['mission', 'goal', '--json'], { cwd: dir });
    assert.equal(goal.status, 0, goal.stderr || goal.stdout);
    const payload = JSON.parse(goal.stdout);
    assert.equal(payload.action, 'codex_goal_candidate');
    assert.equal(payload.goal.mission_id, 'older-codex-work');
  } finally {
    cleanupTempDir(dir);
  }
});

test('mission goal skips agent-certified mission tasks waiting for human accept', { skip: !hasNodeSqlite() && 'node:sqlite unavailable' }, () => {
  const dir = makeTempDir();
  const previousDb = process.env.ATRIS_TASKS_DB;
  let taskDb = null;
  try {
    const taskDbPath = path.join(dir, '.atris', 'tasks.db');
    process.env.ATRIS_TASKS_DB = taskDbPath;
    taskDb = require('../lib/task-db');
    taskDb.close();

    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const db = taskDb.open();
    const task = taskDb.addTask(db, {
      title: 'Mission XP: certified waiting task',
      status: 'review',
      claimedBy: 'auto-improver',
      tag: 'agent-xp',
      workspaceRoot: taskDb.workspaceRoot(dir),
      metadata: {
        approval_status: 'pending',
        agent_review_pass_count: 2,
        agent_certified: true,
        goal_id: 'human-waiting-codex',
      },
    });

    appendMissionState(dir, {
      id: 'older-codex-work',
      slug: 'older-codex-work',
      objective: 'older executable codex mission',
      status: 'running',
      runner: 'codex_goal',
      verifier: 'true',
      created_at: '2026-05-01T00:00:00.000Z',
      updated_at: '2026-05-01T00:00:00.000Z',
    });
    appendMissionState(dir, {
      id: 'human-waiting-codex',
      slug: 'human-waiting-codex',
      objective: 'certified mission waiting for human accept',
      status: 'ready',
      runner: 'codex_goal',
      verifier: 'true',
      always_on: true,
      task_id: task.id,
      current_task_id: task.id,
      task_ids: [task.id],
      xp_task: {
        task_id: task.id,
        ref: 'CLI-999',
      },
      created_at: '2026-05-02T00:00:00.000Z',
      updated_at: '2026-05-02T00:00:00.000Z',
    });

    const selected = selectCodexGoalMission(dir);
    assert.equal(selected.mission.id, 'older-codex-work');
    const due = selectDueMission(dir);
    assert.equal(due.id, 'older-codex-work');

    const goal = runCli(['mission', 'goal', '--json'], { cwd: dir, env: { ATRIS_TASKS_DB: taskDbPath } });
    assert.equal(goal.status, 0, goal.stderr || goal.stdout);
    const payload = JSON.parse(goal.stdout);
    assert.equal(payload.action, 'codex_goal_candidate');
    assert.equal(payload.goal.mission_id, 'older-codex-work');
  } finally {
    if (taskDb) taskDb.close();
    if (previousDb === undefined) delete process.env.ATRIS_TASKS_DB;
    else process.env.ATRIS_TASKS_DB = previousDb;
    cleanupTempDir(dir);
  }
});

test('mission goal seeds next-move continuation after certified mission waits for human accept', { skip: !hasNodeSqlite() && 'node:sqlite unavailable' }, () => {
  const dir = makeTempDir();
  const previousDb = process.env.ATRIS_TASKS_DB;
  let taskDb = null;
  try {
    const taskDbPath = path.join(dir, '.atris', 'tasks.db');
    process.env.ATRIS_TASKS_DB = taskDbPath;
    taskDb = require('../lib/task-db');
    taskDb.close();

    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const db = taskDb.open();
    const task = taskDb.addTask(db, {
      title: 'Mission XP: certified waiting task',
      status: 'review',
      claimedBy: 'auto-improver',
      tag: 'agent-xp',
      workspaceRoot: taskDb.workspaceRoot(dir),
      metadata: {
        approval_status: 'pending',
        agent_review_pass_count: 2,
        agent_certified: true,
        goal_id: 'human-waiting-codex',
      },
    });

    appendMissionState(dir, {
      id: 'human-waiting-codex',
      slug: 'human-waiting-codex',
      objective: 'certified mission waiting for human accept',
      status: 'ready',
      runner: 'codex_goal',
      verifier: 'true',
      always_on: true,
      continue_on_complete: true,
      receipt_path: 'atris/runs/proof.json',
      task_id: task.id,
      current_task_id: task.id,
      task_ids: [task.id],
      xp_task: {
        task_id: task.id,
        ref: 'CLI-999',
      },
      created_at: '2026-05-02T00:00:00.000Z',
      updated_at: '2026-05-02T00:00:00.000Z',
    });

    const goal = runCli(['mission', 'goal', '--json'], { cwd: dir, env: { ATRIS_TASKS_DB: taskDbPath } });
    assert.equal(goal.status, 0, goal.stderr || goal.stdout);
    const payload = JSON.parse(goal.stdout);
    assert.equal(payload.action, 'codex_goal_candidate');
    assert.equal(payload.goal.reason, 'next_move_continuation_seeded');
    assert.equal(
      payload.goal.objective,
      'Decide and start the next useful mission after: certified mission waiting for human accept',
    );
    assert.equal(payload.goal.seeded_continuation_goal.inserted, true);
    assert.equal(payload.goal.seeded_continuation_goal.parent.id, 'human-waiting-codex');
    assert.equal(payload.goal.mission_id, payload.goal.seeded_continuation_goal.mission.id);
    assert.equal(payload.goal.seeded_continuation_goal.mission.started_from, 'mission_run_continuation');
    assert.equal(payload.goal.seeded_continuation_goal.mission.continuation_policy, 'choose_next_mission');

    const secondGoal = runCli(['mission', 'goal', '--json'], { cwd: dir, env: { ATRIS_TASKS_DB: taskDbPath } });
    assert.equal(secondGoal.status, 0, secondGoal.stderr || secondGoal.stdout);
    const secondPayload = JSON.parse(secondGoal.stdout);
    assert.equal(secondPayload.goal.mission_id, payload.goal.mission_id);
  } finally {
    if (taskDb) taskDb.close();
    if (previousDb === undefined) delete process.env.ATRIS_TASKS_DB;
    else process.env.ATRIS_TASKS_DB = previousDb;
    cleanupTempDir(dir);
  }
});

test('mission goal ignores completed handoff continuations when seeding the next mission', { skip: !hasNodeSqlite() && 'node:sqlite unavailable' }, () => {
  const dir = makeTempDir();
  const previousDb = process.env.ATRIS_TASKS_DB;
  let taskDb = null;
  try {
    const taskDbPath = path.join(dir, '.atris', 'tasks.db');
    process.env.ATRIS_TASKS_DB = taskDbPath;
    taskDb = require('../lib/task-db');
    taskDb.close();

    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const db = taskDb.open();
    const staleTask = taskDb.addTask(db, {
      title: 'Mission XP: stale parent waiting',
      status: 'review',
      claimedBy: 'auto-improver',
      tag: 'agent-xp',
      workspaceRoot: taskDb.workspaceRoot(dir),
      metadata: {
        approval_status: 'pending',
        agent_review_pass_count: 2,
        agent_certified: true,
        goal_id: 'stale-parent',
      },
    });
    const currentTask = taskDb.addTask(db, {
      title: 'Mission XP: current planning waiting',
      status: 'review',
      claimedBy: 'auto-improver',
      tag: 'agent-xp',
      workspaceRoot: taskDb.workspaceRoot(dir),
      metadata: {
        approval_status: 'pending',
        agent_review_pass_count: 2,
        agent_certified: true,
        goal_id: 'current-planning',
      },
    });

    appendMissionState(dir, {
      id: 'current-planning',
      slug: 'current-planning',
      objective: 'current certified planning mission',
      status: 'planning',
      runner: 'codex_goal',
      continue_on_complete: true,
      task_id: currentTask.id,
      current_task_id: currentTask.id,
      task_ids: [currentTask.id],
      xp_task: {
        task_id: currentTask.id,
        ref: 'CLI-1000',
      },
      created_at: '2026-05-02T00:00:00.000Z',
      updated_at: '2026-05-02T00:00:00.000Z',
    });
    appendMissionState(dir, {
      id: 'stale-parent',
      slug: 'stale-parent',
      objective: 'stale parent mission',
      status: 'ready',
      runner: 'codex_goal',
      continue_on_complete: true,
      continuation_seeded_mission_id: 'stale-continuation',
      task_id: staleTask.id,
      current_task_id: staleTask.id,
      task_ids: [staleTask.id],
      xp_task: {
        task_id: staleTask.id,
        ref: 'CLI-999',
      },
      created_at: '2026-05-03T00:00:00.000Z',
      updated_at: '2026-05-03T00:00:00.000Z',
    });
    appendMissionState(dir, {
      id: 'stale-continuation',
      slug: 'stale-continuation',
      objective: 'Decide and start the next useful mission after: stale parent mission',
      status: 'complete',
      runner: 'codex_goal',
      started_from: 'mission_run_continuation',
      continuation_policy: 'choose_next_mission',
      parent_mission_id: 'stale-parent',
      continued_by_mission_id: 'already-started',
      created_at: '2026-05-03T00:01:00.000Z',
      updated_at: '2026-05-03T00:01:00.000Z',
    });

    const goal = runCli(['mission', 'goal', '--json'], { cwd: dir, env: { ATRIS_TASKS_DB: taskDbPath } });
    assert.equal(goal.status, 0, goal.stderr || goal.stdout);
    const payload = JSON.parse(goal.stdout);
    assert.equal(payload.action, 'codex_goal_candidate');
    assert.equal(payload.goal.reason, 'next_move_continuation_seeded');
    assert.equal(payload.goal.seeded_continuation_goal.parent.id, 'current-planning');
    assert.notEqual(payload.goal.mission_id, 'stale-continuation');
    assert.equal(
      payload.goal.objective,
      'Decide and start the next useful mission after: current certified planning mission',
    );
  } finally {
    if (taskDb) taskDb.close();
    if (previousDb === undefined) delete process.env.ATRIS_TASKS_DB;
    else process.env.ATRIS_TASKS_DB = previousDb;
    cleanupTempDir(dir);
  }
});

test('mission goal skips blocked caller-session missions', () => {
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
    assert.equal(selected.mission.id, 'old-codex-due');
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

    ackNativeCodexGoal(dir, first);

    // Completion gate requires verifier evidence: pass the verifier first.
    const ticked = runCli(['mission', 'tick', first.id, '--verify', '--json'], { cwd: dir });
    assert.equal(ticked.status, 0, ticked.stderr || ticked.stdout);

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
    assert.match(payload.heartbeat.next_heavy_command, /create_goal/);
    assert.match(payload.heartbeat.next_heavy_command, new RegExp(`mission goal ack ${mission.id}`));

    const state = JSON.parse(fs.readFileSync(payload.state_path, 'utf8'));
    assert.equal(state.action, 'codex_goal_heartbeat');
    assert.equal(state.heartbeat.heavy_work_performed, false);
    assert.equal(state.goal.mission_id, mission.id);
    assert.equal(state.goal.visible_goal.status, 'needs_runtime_write');
    assert.equal(state.goal.requires_native_goal_start, true);
  } finally {
    cleanupTempDir(dir);
  }
});

test('mission goal normalizes engine mission owners into functional owners', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    appendMissionState(dir, {
      id: 'mission-engine-owned-signals',
      objective: 'Watch chat log task signals and infer the next bounded action',
      owner: 'codex',
      runner: 'codex_goal',
      lane: 'code',
      status: 'planning',
      verifier: 'node -e "process.exit(0)"',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    const goal = runCli(['mission', 'goal', '--json'], { cwd: dir });
    assert.equal(goal.status, 0, goal.stderr || goal.stdout);
    const payload = JSON.parse(goal.stdout);
    assert.equal(payload.goal.owner, 'signal-scout');
    assert.equal(payload.goal.executed_by, 'codex');
    assert.equal(payload.goal.task_spine.owner, 'signal-scout');
    assert.equal(payload.goal.task_spine.requested_owner, 'codex');
    assert.equal(payload.goal.task_spine.executed_by, 'codex');
    assert.equal(payload.goal.task_spine.owner_resolution, 'engine_owner_resolved_by_task_signal');
    assert.equal(payload.mission.owner, 'signal-scout');
    assert.equal(payload.mission.requested_owner, 'codex');
    assert.equal(payload.mission.executed_by, 'codex');
    assert.match(payload.goal.next_command, /create_goal/);
    assert.match(payload.goal.next_command, /mission goal ack mission-engine-owned-signals/);
    assert.equal(payload.goal.requires_native_goal_start, true);
    assert.equal(payload.goal.task_spine.ensure_task_command, 'atris mission attach-task mission-engine-owned-signals --json');
  } finally {
    cleanupTempDir(dir);
  }
});

test('mission goal-loop attaches task spine before due mission work', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const env = { ATRIS_TASKS_DB: path.join(dir, 'tasks.db'), ATRIS_AGENT_ID: 'mission-lead' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const started = runCli([
      'mission',
      'start',
      'loop setup codex goal mission',
      '--owner',
      'mission-lead',
      '--runner',
      'codex_goal',
      '--verify',
      'node -e "process.exit(0)"',
      '--json',
    ], { cwd: dir, env });
    assert.equal(started.status, 0, started.stderr || started.stdout);
    const mission = JSON.parse(started.stdout).mission;

    const waiting = runCli(['mission', 'goal-loop', '--max-iterations', '1', '--no-claude', '--json'], { cwd: dir, env });
    assert.equal(waiting.status, 0, waiting.stderr || waiting.stdout);
    const waitingPayload = JSON.parse(waiting.stdout);
    assert.equal(waitingPayload.action, 'codex_goal_loop');
    assert.equal(waitingPayload.heavy_runs, 0);
    assert.equal(waitingPayload.setup_runs, 0);
    assert.equal(waitingPayload.events[0].heartbeat.goal.requires_native_goal_start, true);
    assert.equal(waitingPayload.events[0].run, undefined);

    ackNativeCodexGoal(dir, mission, env);

    const loop = runCli(['mission', 'goal-loop', '--max-iterations', '1', '--no-claude', '--json'], { cwd: dir, env });
    assert.equal(loop.status, 0, loop.stderr || loop.stdout);
    const payload = JSON.parse(loop.stdout);
    assert.equal(payload.action, 'codex_goal_loop');
    assert.equal(payload.iterations, 1);
    assert.equal(payload.heavy_runs, 0);
    assert.equal(payload.setup_runs, 1);
    assert.equal(payload.events[0].heartbeat.goal.next_command, `atris mission attach-task ${mission.id} --json`);
    assert.equal(payload.events[0].run.action, 'mission_attach_task');
    assert.equal(payload.events[0].run.payload.action, 'mission_task_spine_attached');
    assert.equal(payload.events[0].run.payload.task_spine.goal_id, mission.id);
    assert.equal(payload.events[0].after_run.goal.task_spine.has_task, true);
    assert.equal(payload.events[0].after_run.goal.next_command, 'atris mission run --due --max-ticks 1 --complete-on-pass');
    assert.equal(payload.final_state.goal.task_spine.has_task, true);
    assert.equal(payload.final_state.goal.next_command, 'atris mission run --due --max-ticks 1 --complete-on-pass');
  } finally {
    cleanupTempDir(dir);
  }
});

test('mission goal-loop runs due mission work once and refreshes final state', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const env = { ATRIS_TASKS_DB: path.join(dir, 'tasks.db'), ATRIS_AGENT_ID: 'mission-lead' };
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
      '--xp-task',
      '--json',
    ], { cwd: dir, env });
    assert.equal(started.status, 0, started.stderr || started.stdout);
    const mission = JSON.parse(started.stdout).mission;

    ackNativeCodexGoal(dir, mission, env);

    const loop = runCli(['mission', 'goal-loop', '--max-iterations', '1', '--no-claude', '--json'], { cwd: dir, env });
    assert.equal(loop.status, 0, loop.stderr || loop.stdout);
    const payload = JSON.parse(loop.stdout);
    assert.equal(payload.action, 'codex_goal_loop');
    assert.equal(payload.iterations, 1);
    assert.equal(payload.heavy_runs, 1);
    assert.equal(payload.setup_runs, 0);
    assert.equal(payload.events[0].heartbeat.goal.mission_id, mission.id);
    assert.equal(payload.events[0].heartbeat.heartbeat.due, true);
    assert.equal(payload.events[0].run.action, 'mission_run_due');
    assert.equal(payload.events[0].run.payload.action, 'mission_run');
    assert.equal(payload.events[0].run.payload.mission.id, mission.id);
    assert.equal(payload.events[0].run.payload.mission.status, 'ready');
    assert.equal(payload.final_state.action, 'codex_goal_heartbeat');
    assert.equal(payload.final_state.goal.mission_id, mission.id);
    assert.equal(payload.final_state.goal.mission_status, 'ready');
    assert.match(payload.final_state.goal.next_command, new RegExp(`^atris task current-step --goal-id ${mission.id}`));
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
      '--runner',
      'codex_goal',
      '--verify',
      'node -e "process.exit(0)"',
      '--always-on',
      '--cadence',
      '1h',
      '--json',
    ], { cwd: dir });
    assert.equal(started.status, 0, started.stderr || started.stdout);
    const mission = JSON.parse(started.stdout).mission;
    ackNativeCodexGoal(dir, mission);

    const firstRun = runCli(['mission', 'run', '--due', '--no-claude', '--max-ticks', '1', '--complete-on-pass', '--json'], { cwd: dir });
    assert.equal(firstRun.status, 0, firstRun.stderr || firstRun.stdout);
    const firstPayload = JSON.parse(firstRun.stdout);
    assert.equal(firstPayload.mission.status, 'ready');
    assert.equal(firstPayload.ticks[0].tick_index, 1);
    assert.equal(firstPayload.mission.last_tick_index, 1);
    assert.equal(firstPayload.mission.verifier_result.passed, true);

    const heartbeat = runCli(['mission', 'goal', '--heartbeat', '--json'], { cwd: dir });
    assert.equal(heartbeat.status, 0, heartbeat.stderr || heartbeat.stdout);
    const heartbeatPayload = JSON.parse(heartbeat.stdout);
    assert.equal(heartbeatPayload.goal.mission_id, firstPayload.mission.id);
    assert.equal(heartbeatPayload.goal.reason, 'active');
    assert.equal(heartbeatPayload.heartbeat.due, false);
    assert.equal(heartbeatPayload.heartbeat.next_heavy_command, `atris mission attach-task ${firstPayload.mission.id} --json`);

    const afterCadence = new Date(Date.parse(firstPayload.mission.last_tick_at) + (60 * 60 * 1000) + 1000);
    const dueAgain = selectDueMission(dir, afterCadence);
    assert.equal(dueAgain.id, firstPayload.mission.id);

    const secondRun = runCli(['mission', 'run', firstPayload.mission.id, '--no-claude', '--max-ticks', '1', '--complete-on-pass', '--json'], { cwd: dir });
    assert.equal(secondRun.status, 0, secondRun.stderr || secondRun.stdout);
    const secondPayload = JSON.parse(secondRun.stdout);
    assert.equal(secondPayload.mission.status, 'ready');
    assert.equal(secondPayload.ticks[0].tick_index, 2);
    assert.equal(secondPayload.mission.last_tick_index, 2);
  } finally {
    cleanupTempDir(dir);
  }
});

test('manual always-on missions do not auto-rerun after verifier passes', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const started = runCli([
      'mission',
      'start',
      'manual no-op mission',
      '--owner',
      'mission-lead',
      '--verify',
      'node -e "process.exit(0)"',
      '--always-on',
      '--json',
    ], { cwd: dir });
    assert.equal(started.status, 0, started.stderr || started.stdout);

    const firstRun = runCli(['mission', 'run', '--due', '--no-claude', '--max-ticks', '1', '--complete-on-pass', '--json'], { cwd: dir });
    assert.equal(firstRun.status, 0, firstRun.stderr || firstRun.stdout);
    const firstPayload = JSON.parse(firstRun.stdout);
    assert.equal(firstPayload.mission.status, 'ready');
    assert.equal(firstPayload.mission.verifier_result.passed, true);
    assert.equal(selectDueMission(dir), null);

    const goal = runCli(['mission', 'goal', '--json'], { cwd: dir });
    assert.equal(goal.status, 0, goal.stderr || goal.stdout);
    assert.equal(JSON.parse(goal.stdout).action, 'no_goal_candidate');

    const directRun = runCli(['mission', 'run', firstPayload.mission.id, '--no-claude', '--max-ticks', '1', '--complete-on-pass', '--json'], { cwd: dir });
    assert.equal(directRun.status, 0, directRun.stderr || directRun.stdout);
    const directPayload = JSON.parse(directRun.stdout);
    assert.equal(directPayload.mission.status, 'ready');
    assert.equal(directPayload.ticks[0].tick_index, 2);
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
    assert.match(help.stdout, /mission status \[id\] \[--status <state>\] \[--limit <n>\] \[--local\] \[--json\]/);
    assert.match(help.stdout, /mission attach-task <id> \[--json\]/);
    assert.match(help.stdout, /mission report \[id\] \[--limit <n>\] \[--local\] \[--json\]/);
    assert.match(help.stdout, /mission timeline \[id\] \[--limit <n>\] \[--all\] \[--prune-preview\] \[--write\] \[--json\]/);
    assert.match(help.stdout, /rolls up sibling git-worktree missions/);
    assert.match(help.stdout, /mission goal \[--runtime codex\|atris\] \[--heartbeat\] \[--native-goal-status active\|paused\] \[--native-goal-objective "\.\.\."\] \[--allow-native-goal-supersede\] \[--json\]/);
    assert.match(help.stdout, /mission goal ack <id> --runtime codex --status active --objective "<objective>" --json/);
    assert.match(help.stdout, /mission goal-loop \[--max-wall 28800\] \[--max-iterations 32\] \[--no-claude\] \[--json\]/);
    assert.match(help.stdout, /--spend-full-budget\|--use-whole-budget\|--stop-when-done/);
    assert.match(help.stdout, /plain time like "20 minutes" means finish early if solved/);
    assert.match(help.stdout, /Autonomy recipe:/);
    assert.match(help.stdout, /Codex sessions: read native get_goal, then pass its status into atris mission goal --native-goal-status <status>/);
    assert.match(help.stdout, /Overnight controller: atris mission goal --heartbeat --json/);
    assert.match(help.stdout, /Bounded overnight runner: atris mission goal-loop --max-wall 28800 --no-claude --json/);
    assert.match(help.stdout, /Headless: start with --runner claude --cadence "15m" --always-on/);
    assert.match(help.stdout, /Backend\/web agents:/);
    assert.match(help.stdout, /--status active shows planning\/running\/ready\/paused\/blocked missions/);
  } finally {
    cleanupTempDir(dir);
  }
});
