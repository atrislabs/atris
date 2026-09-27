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

function runAtris(workspace, args) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: workspace,
    encoding: 'utf8',
    env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1', ATRIS_TASKS_DB: path.join(workspace, '.atris', 'tasks.db') },
  });
  assert.equal(result.status, 0, `atris ${args.join(' ')}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  return result;
}

test('recreating a completed score goal the same day leaves the new goal active', () => withTempWorkspace((workspace) => {
  fs.mkdirSync(path.join(workspace, 'atris'), { recursive: true });
  runAtris(workspace, ['member', 'create', 'scorer', '--description="Turn score evidence into goals"']);
  const scorePath = path.join(workspace, 'team-score.json');
  fs.writeFileSync(scorePath, JSON.stringify({
    score: {
      overall: 74,
      nextMove: 'Raise Member Performance: Train the weakest member attribute with one verified loop.',
      weakest: { id: 'member_performance', label: 'Member Performance', score: 60 },
    },
  }, null, 2), 'utf8');
  runAtris(workspace, ['member', 'goal-from-score', 'scorer', '--score-json', scorePath, '--json']);

  const memberDir = path.join(workspace, 'atris', 'team', 'scorer');
  const done = readGoals(memberDir);
  const scoreGoal = done.goals.find((goal) => goal.source === 'team_score');
  scoreGoal.status = 'completed';
  scoreGoal.completed_at = new Date().toISOString();
  writeGoals(memberDir, done);

  // Same title, same day: the new goal gets the same id as the finished one.
  runAtris(workspace, ['member', 'goal-from-score', 'scorer', '--score-json', scorePath, '--json']);
  const after = readGoals(memberDir);
  const scoreGoals = after.goals.filter((goal) => goal.source === 'team_score');
  assert.equal(scoreGoals.filter((goal) => goal.status === 'completed').length, 1);
  assert.equal(scoreGoals.filter((goal) => goal.status === 'active').length, 1, 'the deliberately new goal must stay active');
}));

test('merging disk history does not undo the 50-entry history cap', () => withTempWorkspace((workspace) => {
  fs.mkdirSync(path.join(workspace, 'atris'), { recursive: true });
  runAtris(workspace, ['member', 'create', 'capper', '--description="Make Missions change the world"']);
  runAtris(workspace, ['mission', 'start', '--no-verify', 'Make Missions change the world', '--owner', 'capper', '--json']);
  runAtris(workspace, ['member', 'goal-from-mission', 'capper', '--json']);

  const memberDir = path.join(workspace, 'atris', 'team', 'capper');
  const state = readGoals(memberDir);
  const goal = state.goals[0];
  goal.history = Array.from({ length: 60 }, (_, index) => ({
    at: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
    event: `old_event_${index}`,
  }));
  writeGoals(memberDir, state);

  runAtris(workspace, ['member', 'goal-from-mission', 'capper', '--json']);
  const after = readGoals(memberDir).goals.find((item) => item.id === goal.id);
  assert.ok(after.history.length <= 50, `history must stay capped, got ${after.history.length}`);
  assert.equal(after.history.some((entry) => entry.event === 'old_event_0'), false, 'trimmed entries must not come back');
}));

test('thirty reviews recorded in the same millisecond all survive the write', () => withTempWorkspace((workspace) => {
  const memberDir = seedMember(workspace, 'reviewer', [
    {
      id: 'goal-r',
      title: 'Goal R',
      status: 'active',
      created_at: '2026-09-20T00:00:00.000Z',
      history: [{ at: '2026-09-20T00:00:00.000Z', event: 'goal_created' }],
      experiments: [],
    },
  ]);
  const { loadMemberGoals, writeMemberGoals, memberPaths } = require('../commands/member');
  const state = loadMemberGoals('reviewer');
  const at = '2026-09-26T03:00:00.000Z';
  for (let index = 0; index < 30; index += 1) {
    state.goals[0].history.push({ at, event: 'experiment_accepted', experiment_id: `exp-${index}`, value: 4 });
  }
  // Two entries the writer made that happen to be identical are both kept.
  state.goals[0].history.push({ at, event: 'goal_updated' }, { at, event: 'goal_updated' });
  writeMemberGoals(memberPaths('reviewer'), state);

  const history = readGoals(memberDir).goals[0].history;
  assert.equal(history.filter((entry) => entry.event === 'experiment_accepted').length, 30);
  assert.equal(history.filter((entry) => entry.event === 'goal_updated').length, 2);
  assert.equal(history.length, 33);
}));
