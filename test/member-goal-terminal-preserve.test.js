const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

function withTempWorkspace(run) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-goal-terminal-'));
  const previous = process.cwd();
  try {
    process.chdir(workspace);
    return run(workspace);
  } finally {
    process.chdir(previous);
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

function seedMember(workspace, name, goals) {
  const memberDir = path.join(workspace, 'atris', 'team', name);
  fs.mkdirSync(memberDir, { recursive: true });
  fs.writeFileSync(path.join(memberDir, 'MEMBER.md'), `---\nname: ${name}\nrole: Test\n---\n`, 'utf8');
  const state = {
    schema: 'atris.member_goals.v1',
    member: name,
    updated_at: '2026-09-26T00:00:00.000Z',
    goals,
  };
  fs.writeFileSync(path.join(memberDir, 'goals.json'), JSON.stringify(state, null, 2) + '\n', 'utf8');
  return memberDir;
}

function readGoals(memberDir) {
  return JSON.parse(fs.readFileSync(path.join(memberDir, 'goals.json'), 'utf8'));
}

function writeGoals(memberDir, state) {
  fs.writeFileSync(path.join(memberDir, 'goals.json'), JSON.stringify(state, null, 2) + '\n', 'utf8');
}

test('writeMemberGoals preserves terminal statuses and unions history when memory is stale', () => withTempWorkspace((workspace) => {
  const memberDir = seedMember(workspace, 'keeper', [
    {
      id: 'goal-a',
      title: 'Goal A',
      status: 'active',
      created_at: '2026-09-20T00:00:00.000Z',
      history: [{ at: '2026-09-20T00:00:00.000Z', event: 'goal_created' }],
      experiments: [],
    },
    {
      id: 'goal-b',
      title: 'Goal B',
      status: 'active',
      created_at: '2026-09-20T00:00:00.000Z',
      history: [{ at: '2026-09-20T00:00:00.000Z', event: 'goal_created' }],
      experiments: [],
    },
  ]);
  const { loadMemberGoals, writeMemberGoals, memberPaths } = require('../commands/member');
  const stale = loadMemberGoals('keeper');

  // A repair lands on disk after the load: A completes, B supersedes, C arrives.
  const disk = readGoals(memberDir);
  disk.goals[0].status = 'completed';
  disk.goals[0].completed_at = '2026-09-26T01:00:00.000Z';
  disk.goals[0].history.push({ at: '2026-09-26T01:00:00.000Z', event: 'goal_completed' });
  disk.goals[1].status = 'superseded';
  disk.goals[1].superseded_at = '2026-09-26T01:00:00.000Z';
  disk.goals.push({
    id: 'goal-c',
    title: 'Goal C',
    status: 'active',
    created_at: '2026-09-26T01:00:00.000Z',
    history: [],
    experiments: [],
  });
  writeGoals(memberDir, disk);

  // The stale writer mutates A and writes the whole file back.
  stale.goals[0].history.push({ at: '2026-09-26T02:00:00.000Z', event: 'goal_updated' });
  writeMemberGoals(memberPaths('keeper'), stale);

  const after = readGoals(memberDir);
  const goalA = after.goals.find((goal) => goal.id === 'goal-a');
  assert.equal(goalA.status, 'completed');
  assert.equal(goalA.completed_at, '2026-09-26T01:00:00.000Z');
  const eventsA = goalA.history.map((entry) => entry.event);
  assert.ok(eventsA.includes('goal_created'));
  assert.ok(eventsA.includes('goal_completed'));
  assert.ok(eventsA.includes('goal_updated'));
  assert.ok(eventsA.includes('terminal_state_preserved'));
  const goalB = after.goals.find((goal) => goal.id === 'goal-b');
  assert.equal(goalB.status, 'superseded');
  assert.ok(after.goals.some((goal) => goal.id === 'goal-c'));
}));

test('member goal mints a fresh goal instead of resurrecting a completed one', () => withTempWorkspace((workspace) => {
  const memberDir = seedMember(workspace, 'writer', [
    {
      id: 'goal-2026-09-20-old',
      title: 'Ship the thing',
      status: 'completed',
      completed_at: '2026-09-20T00:00:00.000Z',
      created_at: '2026-09-19T00:00:00.000Z',
      history: [{ at: '2026-09-20T00:00:00.000Z', event: 'goal_completed' }],
      experiments: [],
    },
  ]);
  const result = spawnSync(process.execPath, [cliPath, 'member', 'goal', 'writer', 'Ship the thing'], {
    cwd: workspace,
    encoding: 'utf8',
    env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1' },
  });
  assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);

  const after = readGoals(memberDir);
  const old = after.goals.find((goal) => goal.id === 'goal-2026-09-20-old');
  assert.equal(old.status, 'completed');
  assert.equal(old.completed_at, '2026-09-20T00:00:00.000Z');
  const actives = after.goals.filter((goal) => goal.status === 'active');
  assert.equal(actives.length, 1);
  assert.notEqual(actives[0].id, old.id);
  assert.equal(actives[0].title, 'Ship the thing');

  // A second run reuses the living goal, not the terminal one.
  const again = spawnSync(process.execPath, [cliPath, 'member', 'goal', 'writer', 'Ship the thing'], {
    cwd: workspace,
    encoding: 'utf8',
    env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1' },
  });
  assert.equal(again.status, 0, `stdout:\n${again.stdout}\nstderr:\n${again.stderr}`);
  const afterAgain = readGoals(memberDir);
  assert.equal(afterAgain.goals.filter((goal) => goal.status === 'active').length, 1);
  assert.equal(afterAgain.goals.length, after.goals.length);
}));
