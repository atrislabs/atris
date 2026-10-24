'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// The function under test reads process.env.ATRIS_AGENT_ID (owner fallback)
// and may resolve member dirs under cwd, so pin the env before requiring.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-codex-goal-next-'));
for (const key of Object.keys(process.env)) {
  if (key.startsWith('ATRIS_')) delete process.env[key];
}
process.env.HOME = tmpHome;

const { codexGoalNextCommand } = require('../commands/mission');

test('codex_goal runner without a native goal ack returns the create_goal instruction', () => {
  const mission = {
    id: 'm-101',
    runner: 'codex_goal',
    status: 'running',
    owner: 'mission-lead',
    objective: 'fix flaky mission tick test',
  };
  assert.equal(
    codexGoalNextCommand(mission),
    'Call native Codex create_goal({ objective: "fix flaky mission tick test" }), '
      + "then run atris mission goal ack m-101 --runtime codex --status active --objective 'fix flaky mission tick test' --json",
  );
});

test('codex_goal runner with a matching active ack moves past the goal gate', () => {
  const mission = {
    id: 'm-101',
    runner: 'codex_goal',
    status: 'running',
    owner: 'mission-lead',
    objective: 'fix flaky mission tick test',
    task_id: 'T-7',
    verifier: 'node --test test/x.test.js',
    native_goal_ack: { runtime: 'codex', status: 'active', mission_id: 'm-101' },
  };
  // No last_tick_at means the mission is always due, so a verifier routes to a due run.
  assert.equal(
    codexGoalNextCommand(mission),
    'atris mission run --due --max-ticks 1 --complete-on-pass',
  );
});

test('mission with no task attachment returns the attach-task command', () => {
  const mission = {
    id: 'm-202',
    status: 'running',
    owner: 'mission-lead',
    verifier: 'npm test',
  };
  assert.equal(codexGoalNextCommand(mission), 'atris mission attach-task m-202 --json');
});

test('verified mission that is not yet due returns a verify tick', () => {
  const mission = {
    id: 'm-303',
    status: 'running',
    owner: 'mission-lead',
    task_id: 'T-9',
    verifier: 'npm test',
    cadence: '1h',
    // Far-future fixed stamp keeps the mission not-due on any clock or timezone.
    last_tick_at: '2999-01-01T00:00:00.000Z',
  };
  assert.equal(
    codexGoalNextCommand(mission),
    'atris mission tick m-303 --verify --summary "<what changed>"',
  );
});

test('ready always-on mission returns the plain run command', () => {
  const mission = {
    id: 'm-404',
    status: 'ready',
    always_on: true,
    owner: 'mission-lead',
    task_id: 'T-1',
  };
  assert.equal(codexGoalNextCommand(mission), 'atris mission run m-404');
});

test('ready mission with an xp task and receipt returns the AgentXP review command', () => {
  const mission = {
    id: 'm-505',
    status: 'ready',
    owner: 'validator',
    objective: 'queue the proof review',
    task_id: 'T-2',
    xp_task: { ref: 'T-2' },
    receipt_path: 'atris/logs/receipts/m-505.json',
  };
  assert.equal(
    codexGoalNextCommand(mission),
    'atris task current-step --goal-id m-505 --as validator --proof "<proof>" --json',
  );
});

test('empty mission object falls through to an unverified tick', () => {
  assert.equal(
    codexGoalNextCommand({}),
    'atris mission tick undefined --summary "<what changed>"',
  );
});

test('null mission throws because status cannot be read', () => {
  assert.throws(() => codexGoalNextCommand(null), TypeError);
});
