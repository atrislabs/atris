'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { scrubAgentEnv } = require('./helpers/agent-env');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

function makeTempWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-member-fleet-'));
}

function runCli(args, cwd) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 20000,
    env: {
      ...scrubAgentEnv(),
      ATRIS_SKIP_UPDATE_CHECK: '1',
    },
  });
  if (result.error) throw result.error;
  return result;
}

function writeMember(root, name) {
  const dir = path.join(root, 'atris', 'team', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'MEMBER.md'), [
    '---',
    `name: ${name}`,
    'role: Test Member',
    '---',
    '',
    `# ${name}`,
    '',
  ].join('\n'), 'utf8');
  return dir;
}

function writeGoal(root, name) {
  const dir = path.join(root, 'atris', 'team', name);
  fs.writeFileSync(path.join(dir, 'goals.json'), JSON.stringify({
    schema: 'atris.member_goals.v1',
    member: name,
    goals: [
      {
        id: `goal-${name}`,
        title: `Goal for ${name}`,
        status: 'active',
        experiments: [],
      },
    ],
  }, null, 2));
}

function isoAgo(ms) {
  return new Date(Date.now() - ms).toISOString();
}

function writeMissions(root, missions) {
  const stateDir = path.join(root, '.atris', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, 'missions.jsonl'),
    missions.map((mission) => JSON.stringify(mission)).join('\n') + '\n',
    'utf8',
  );
}

test('member status --all merges goal, mission, and activity planes', () => {
  const root = makeTempWorkspace();
  try {
    writeMember(root, 'live-empty-goal');
    writeMember(root, 'goal-recent');
    writeMember(root, 'captain');
    writeMember(root, '_archive');
    writeGoal(root, 'goal-recent');
    writeMissions(root, [
      {
        id: 'mission-live-empty-goal',
        slug: 'mission-live-empty-goal',
        owner: 'live-empty-goal',
        status: 'running',
        last_tick_at: isoAgo(60 * 60 * 1000),
        updated_at: isoAgo(60 * 60 * 1000),
      },
      {
        id: 'mission-goal-recent',
        slug: 'mission-goal-recent',
        owner: 'goal-recent',
        status: 'complete',
        last_tick_at: isoAgo(30 * 60 * 60 * 1000),
        updated_at: isoAgo(30 * 60 * 60 * 1000),
      },
    ]);
    const runsDir = path.join(root, 'atris', 'runs');
    fs.mkdirSync(runsDir, { recursive: true });
    const recentRun = path.join(runsDir, 'member-loop-goal-recent-proof.json');
    fs.writeFileSync(recentRun, '{}\n', 'utf8');
    const recent = new Date(Date.now() - 30 * 60 * 60 * 1000);
    fs.utimesSync(recentRun, recent, recent);

    const result = runCli(['member', 'status', '--all'], root);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Member fleet status/);
    assert.match(result.stdout, /^live-empty-goal\s+no_goal\s+mission-live-empty-goal\s+running\s+\S+\s+\S+\s+ACTIVE/m);
    assert.match(result.stdout, /^goal-recent\s+ready\s+mission-goal-recent\s+complete\s+\S+\s+\S+\s+RECENT/m);
    assert.match(result.stdout, /^captain\s+no_goal\s+-\s+-\s+-\s+-\s+IDLE/m);
    assert.doesNotMatch(result.stdout, /_archive/);

    const single = runCli(['member', 'status', 'live-empty-goal'], root);
    assert.equal(single.status, 0, single.stderr || single.stdout);
    assert.match(single.stdout, /mission {3}mission-live-empty-goal \(running, last tick \S+\)/);
    assert.match(single.stdout, /live-empty-goal .*active, last activity/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('member alive --all skips members with no goal and no active mission while previewing cron lines', () => {
  const root = makeTempWorkspace();
  try {
    writeMember(root, 'live-empty-goal');
    writeMember(root, 'goal-member');
    writeMember(root, 'idle-member');
    writeMember(root, 'stopped-member');
    writeGoal(root, 'goal-member');
    writeMissions(root, [
      {
        id: 'mission-live-empty-goal',
        slug: 'mission-live-empty-goal',
        owner: 'live-empty-goal',
        status: 'running',
        last_tick_at: isoAgo(60 * 60 * 1000),
        updated_at: isoAgo(60 * 60 * 1000),
      },
      {
        id: 'mission-stopped-member',
        slug: 'mission-stopped-member',
        owner: 'stopped-member',
        status: 'stopped',
        last_tick_at: isoAgo(60 * 60 * 1000),
        updated_at: isoAgo(60 * 60 * 1000),
      },
    ]);

    const result = runCli(['member', 'alive', '--all', '--install', '--hourly', '--forever', '--dry-run'], root);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Activate goal-member: goal/);
    assert.match(result.stdout, /Activate live-empty-goal: mission mission-live-empty-goal/);
    assert.match(result.stdout, /Skip idle-member: no goal and no active mission\./);
    assert.match(result.stdout, /Skip stopped-member: no goal and no active mission\./);
    assert.match(result.stdout, /Would install hourly alive loop: goal-member/);
    assert.match(result.stdout, /Cron: .*ATRIS_MEMBER_ALIVE_GOAL_MEMBER/);
    assert.match(result.stdout, /Cron: .*ATRIS_MEMBER_ALIVE_LIVE_EMPTY_GOAL/);
    assert.match(result.stdout, /Summary: 2 activated, 2 skipped \(no_goal_and_no_active_mission x2\)\./);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
