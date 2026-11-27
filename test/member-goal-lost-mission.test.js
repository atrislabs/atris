'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { scrubAgentEnv } = require('./helpers/agent-env');
const { runAliveTick } = require('../lib/member-alive');
const memberCore = require('../lib/member-core');

const cliPath = path.join(__dirname, '..', 'bin', 'atris.js');
const DAY_MS = 24 * 60 * 60 * 1000;

function makeWorkspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-lost-mission-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const memberDir = path.join(dir, 'atris', 'team', 'navigator');
  fs.mkdirSync(memberDir, { recursive: true });
  fs.writeFileSync(path.join(memberDir, 'MEMBER.md'), [
    '---',
    'name: navigator',
    'role: Navigator',
    '---',
    '',
    '# Navigator',
    '',
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(memberDir, 'MISSION.md'), [
    '# Mission',
    '',
    '## North Star',
    '',
    'Keep workspace maps accurate and current.',
    '',
  ].join('\n'), 'utf8');
  return { dir, memberDir };
}

function writeNow(memberDir, { id, status = 'running', ageDays = 0, heading = 'Map missing mission' } = {}) {
  const nowPath = path.join(memberDir, 'now.md');
  fs.writeFileSync(nowPath, [
    '# Now',
    '',
    `## ${heading}`,
    `- id: ${id}`,
    `- status: ${status}`,
    '- next: inspect the map',
    '',
  ].join('\n'), 'utf8');
  if (ageDays > 0) {
    const past = new Date(Date.now() - ageDays * DAY_MS);
    fs.utimesSync(nowPath, past, past);
  }
  return nowPath;
}

function writeGoal(memberDir, missionId) {
  const goalsPath = path.join(memberDir, 'goals.json');
  const state = {
    schema: 'atris.member_goals.v1',
    member: 'navigator',
    updated_at: '2026-10-01T00:00:00.000Z',
    goals: [
      {
        id: 'goal-2026-10-01-lost',
        title: 'Map missing mission',
        status: 'active',
        cadence: 'manual',
        source: 'mission',
        mission_id: missionId,
        mission_north_star: 'Keep workspace maps accurate and current.',
        created_at: '2026-10-01T00:00:00.000Z',
        experiments: [],
        history: [],
      },
    ],
  };
  fs.writeFileSync(goalsPath, JSON.stringify(state, null, 2), 'utf8');
  return { goalsPath, state };
}

function runCli(dir, args, env = {}) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 20000,
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

test('9-day-old now.md naming a vanished mission returns needs_user even with --force and leaves goals.json untouched', (t) => {
  const { dir, memberDir } = makeWorkspace(t);
  const vanishedId = 'mission-2026-10-01-vanished';
  writeNow(memberDir, { id: vanishedId, status: 'running', ageDays: 9 });
  const { goalsPath, state: beforeGoals } = writeGoal(memberDir, vanishedId);
  fs.mkdirSync(path.join(dir, '.atris', 'state'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.atris', 'state', 'missions.jsonl'), '', 'utf8');

  for (const extra of [[], ['--force']]) {
    const res = runCli(dir, ['member', 'goal-from-mission', 'navigator', ...extra, '--json']);
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.action, 'needs_user');
    assert.equal(payload.needs_user, true);
    assert.equal(payload.reason, 'mission_record_missing');
    assert.equal(payload.mission.record_found, false);
    assert.ok(payload.mission.page_idle_days >= 9, `expected >= 9 idle days, got ${payload.mission.page_idle_days}`);
    assert.equal(payload.stale_goals.length, 1);
    assert.equal(payload.stale_goals[0].id, 'goal-2026-10-01-lost');
  }

  const afterGoals = JSON.parse(fs.readFileSync(goalsPath, 'utf8'));
  assert.deepEqual(afterGoals, beforeGoals, 'goals.json must not be modified');

  // member wake also surfaces needs_user instead of burning a tick
  const wakeRes = runCli(dir, ['member', 'wake', 'navigator', '--plan', '--json']);
  assert.equal(wakeRes.status, 0, wakeRes.stderr || wakeRes.stdout);
  const wakePayload = JSON.parse(wakeRes.stdout);
  assert.equal(wakePayload.decision, 'ask');
  assert.equal(wakePayload.needs_user, true);
  assert.equal(wakePayload.reason, 'mission_record_missing');

  // runAliveTick stops on prime needs_user without calling member wake
  const tick = runAliveTick('navigator', { cwd: dir, atrisBin: cliPath, execute: true, confirmed: true });
  assert.equal(tick.status, 'needs_user');
  assert.equal(tick.needs_user, true);
  assert.equal(tick.reason, 'mission_record_missing');
  assert.equal(tick.wake.skipped, true);
  assert.equal(tick.operate.skipped, true);
});

test('fresh now.md naming a mission absent from root missions.jsonl still reuses the goal', (t) => {
  const { dir, memberDir } = makeWorkspace(t);
  const worktreeMissionId = 'mission-2026-11-26-fresh-worktree';
  writeNow(memberDir, { id: worktreeMissionId, status: 'running', ageDays: 0 });
  writeGoal(memberDir, worktreeMissionId);
  fs.mkdirSync(path.join(dir, '.atris', 'state'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.atris', 'state', 'missions.jsonl'), '', 'utf8');

  const res = runCli(dir, ['member', 'goal-from-mission', 'navigator', '--json']);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const payload = JSON.parse(res.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.action, 'goal_from_mission_reused');
  assert.equal(payload.needs_user, undefined);
});

test('9-day-old now.md whose mission IS present in missions.jsonl still reuses the goal', (t) => {
  const { dir, memberDir } = makeWorkspace(t);
  const existingId = 'mission-2026-10-01-still-here';
  writeNow(memberDir, { id: existingId, status: 'running', ageDays: 9 });
  writeGoal(memberDir, existingId);
  fs.mkdirSync(path.join(dir, '.atris', 'state'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.atris', 'state', 'missions.jsonl'), `${JSON.stringify({
    schema: 'atris.mission.v1',
    id: existingId,
    owner: 'navigator',
    objective: 'Map missing mission',
    status: 'running',
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
  })}\n`, 'utf8');

  const res = runCli(dir, ['member', 'goal-from-mission', 'navigator', '--json']);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const payload = JSON.parse(res.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.action, 'goal_from_mission_reused');
  assert.equal(payload.needs_user, undefined);
});

test('memberRuntimeMissionLost returns null when missions.jsonl is unreadable', (t) => {
  const { dir, memberDir } = makeWorkspace(t);
  const id = 'mission-2026-10-01-unreadable';
  writeNow(memberDir, { id, status: 'running', ageDays: 9 });
  // Make missions.jsonl a directory so fs.readFileSync throws EISDIR regardless of user privileges.
  fs.mkdirSync(path.join(dir, '.atris', 'state', 'missions.jsonl'), { recursive: true });

  assert.equal(typeof memberCore.memberRuntimeMissionLost, 'function');
  const lost = memberCore.memberRuntimeMissionLost(
    { memberDir },
    { id, status: 'running' },
    { root: dir },
  );
  assert.equal(lost, null, 'unreadable mission store must not falsely declare a mission lost');
});

test('wakeDecision detects vanished goal mission even when now.md names a different completed mission', (t) => {
  const { dir, memberDir } = makeWorkspace(t);
  const completedOtherId = 'mission-2026-10-01-completed-other';
  const vanishedGoalId = 'mission-2026-10-01-vanished-goal';
  writeNow(memberDir, { id: completedOtherId, status: 'complete', ageDays: 9, heading: 'Completed other mission' });
  writeGoal(memberDir, vanishedGoalId);
  fs.mkdirSync(path.join(dir, '.atris', 'state'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.atris', 'state', 'missions.jsonl'), `${JSON.stringify({
    schema: 'atris.mission.v1',
    id: completedOtherId,
    owner: 'navigator',
    objective: 'Completed other mission',
    status: 'complete',
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
  })}\n`, 'utf8');

  const wakeRes = runCli(dir, ['member', 'wake', 'navigator', '--plan', '--json']);
  assert.equal(wakeRes.status, 0, wakeRes.stderr || wakeRes.stdout);
  const wakePayload = JSON.parse(wakeRes.stdout);
  assert.equal(wakePayload.decision, 'ask');
  assert.equal(wakePayload.needs_user, true);
  assert.equal(wakePayload.reason, 'mission_record_missing');
});

test('member loop --alive --execute reports executed: false when operate is skipped on needs_user', (t) => {
  const { dir, memberDir } = makeWorkspace(t);
  const vanishedId = 'mission-2026-10-01-vanished-loop';
  writeNow(memberDir, { id: vanishedId, status: 'running', ageDays: 9 });
  writeGoal(memberDir, vanishedId);
  fs.mkdirSync(path.join(dir, '.atris', 'state'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.atris', 'state', 'missions.jsonl'), '', 'utf8');

  const res = runCli(dir, [
    'member', 'loop', 'navigator', '--alive', '--execute', '--confirm-autonomy-policy',
    '--ticks', '1', '--interval', '0', '--json',
  ]);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const payload = JSON.parse(res.stdout);
  assert.equal(payload.ok, true);
  assert.ok(payload.log_path, `expected log_path in loop payload: ${res.stdout}`);
  const tickRows = fs.readFileSync(payload.log_path, 'utf8')
    .trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(tickRows.length, 1);
  assert.equal(tickRows[0].needs_user, true);
  assert.equal(tickRows[0].executed, false, 'skipped operate must never report executed: true');
});

test('activeGoal normalizes status casing/whitespace and excludes failed and cancelled goals', () => {
  assert.equal(
    memberCore.activeGoal({
      goals: [
        { id: 'g-failed', status: 'failed' },
        { id: 'g-cancelled', status: 'CANCELLED' },
        { id: 'g-done', status: '  Done  ' },
        { id: 'g-paused', status: 'Paused' },
      ],
    }),
    null,
  );
  assert.equal(
    memberCore.activeGoal({
      goals: [
        { id: 'g-failed', status: 'failed' },
        { id: 'g-active', status: ' ACTIVE ' },
      ],
    })?.id,
    'g-active',
  );
  assert.equal(
    memberCore.activeGoal({
      goals: [
        { id: 'g-cancelled', status: 'cancelled' },
        { id: 'g-open', status: 'pending' },
      ],
    })?.id,
    'g-open',
  );
});
