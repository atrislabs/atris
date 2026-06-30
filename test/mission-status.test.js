const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
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
    assert.match(humanCompleted.stdout, /How I checked: I checked the passing verifier receipt/);
    assert.match(humanCompleted.stdout, /What I tested: Verifier passed: node -e "process\.exit\(0\)"/);
    assert.match(humanCompleted.stdout, /Proof: Proof saved at/);
    assert.match(humanCompleted.stdout, /Next: Pick the next customer-facing move\./);
    assert.doesNotMatch(humanCompleted.stdout, /AgentXP:/);
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
    assert.match(ran.stdout, /Next: Review the proof, then complete the mission\./);
    assert.doesNotMatch(ran.stdout, /^(Ran mission|  objective|  ran_ticks|  final state|  session|  summary receipt):/m);
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

    const input = 'we only have 30 days of runway and need Atris Mission to become the product led growth wedge';
    const res = runCli(['mission', 'room', input, '--owner', 'mission-lead', '--json'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.equal(res.stderr, '');

    const payload = JSON.parse(res.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.action, 'mission_room_created');
    assert.equal(payload.room.schema, 'atris.mission_room.v1');
    assert.match(payload.room.name, /Mission Room$/);
    assert.match(payload.room.target_outcome, /proof-backed mission/);
    assert.equal(payload.room.clarifying_questions.length, 3);
    assert.match(payload.room.clarifying_questions[0].question, /undeniably done/);
    assert.equal(payload.room.approval_packet.status, 'awaiting_operator_approval');
    assert.match(payload.room.approval_packet.operator_role, /judgment, priority, and final accept/);
    assert.deepEqual(payload.room.approval_packet.decision_options, ['approve', 'revise', 'stop']);
    assert.equal(payload.room.goal_chain.mode, 'approval_gated');
    assert.match(payload.room.goal_chain.loop, /clarify -> approve packet -> set one goal/);
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
    assert.match(payload.room.result.landing.changed, /Pending:/);
    assert.match(payload.room.result.landing.checked, /Pending:/);
    assert.equal(payload.room.result.landing.proof, null);
    assert.match(payload.room.result.landing.decision, /accept, revise/);
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
    assert.equal(receipt.room.task_plan_preview.order, 'task_first');
    assert.equal(receipt.room.member_route.editable, true);
    assert.equal(receipt.room.result.landing.status, 'pending_goal_run');
    assert.equal(receipt.room.member_context.status, 'member_selected');
    assert.equal(receipt.room.proactive_next_mission.selected_member, 'mission-lead');
    assert.equal(receipt.thinking_memory.path, 'atris/thinking.md');
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
    assert.match(help.stdout, /rolls up sibling git-worktree missions/);
    assert.match(help.stdout, /mission goal \[--runtime codex\|atris\] \[--heartbeat\] \[--json\]/);
    assert.match(help.stdout, /mission goal ack <id> --runtime codex --status active --objective "<objective>" --json/);
    assert.match(help.stdout, /mission goal-loop \[--max-wall 28800\] \[--max-iterations 32\] \[--no-claude\] \[--json\]/);
    assert.match(help.stdout, /Autonomy recipe:/);
    assert.match(help.stdout, /Codex sessions: atris mission goal --json, create the native goal, then run atris mission goal ack/);
    assert.match(help.stdout, /Overnight controller: atris mission goal --heartbeat --json/);
    assert.match(help.stdout, /Bounded overnight runner: atris mission goal-loop --max-wall 28800 --no-claude --json/);
    assert.match(help.stdout, /Headless: start with --runner claude --cadence "15m" --always-on/);
    assert.match(help.stdout, /Backend\/web agents:/);
    assert.match(help.stdout, /--status active shows planning\/running\/ready\/paused\/blocked missions/);
  } finally {
    cleanupTempDir(dir);
  }
});
