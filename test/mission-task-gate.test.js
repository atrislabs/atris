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
const PASSING_VERIFIER = `${process.execPath} -e "process.exit(0)"`;

const { hasNodeSqlite } = require('./helpers/node-sqlite');

function makeWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-mission-task-gate-'));
  fs.mkdirSync(path.join(dir, 'atris', 'team', 'game-manager'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'atris', 'team', 'game-manager', 'MEMBER.md'), '# Game Manager\n');
  return dir;
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function runCli(dir, args) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 20000,
    env: {
      ...scrubAgentEnv(),
      ATRIS_TASKS_DB: path.join(dir, 'tasks.db'),
      ATRIS_SKIP_UPDATE_CHECK: '1',
      NODE_NO_WARNINGS: '1',
    },
  });
  if (result.error) throw result.error;
  return result;
}

function startMission(dir, objective, extra = []) {
  const start = runCli(dir, ['mission', 'start', '--no-verify', objective, '--owner', 'game-manager', '--json', ...extra]);
  assert.equal(start.status, 0, start.stderr || start.stdout);
  return JSON.parse(start.stdout).mission;
}

// The short id `atris task` prints (T6V-2), found the way a user would.
function shortRefOf(dir, taskId) {
  const board = runCli(dir, ['task', 'list', '--json']);
  assert.equal(board.status, 0, board.stderr || board.stdout);
  const row = JSON.parse(board.stdout).tasks.find((task) => task.id === taskId);
  assert.ok(row && row.display_id, board.stdout);
  return row.display_id;
}

function errorText(result) {
  return `${result.stdout}\n${result.stderr}`;
}

function missionFromList(dir, id) {
  const list = runCli(dir, ['mission', 'list', '--json']);
  assert.equal(list.status, 0, list.stderr || list.stdout);
  return JSON.parse(list.stdout).missions.find((m) => m.id === id);
}

test('mission complete refuses while the linked task is not accepted, naming the task and the accept command', { skip: !hasNodeSqlite() }, () => {
  const dir = makeWorkspace();
  try {
    const mission = startMission(dir, 'Ship one linked thing', ['--xp-task']);
    const taskId = mission.xp_task.task_id;
    assert.ok(taskId);

    const refused = runCli(dir, ['mission', 'complete', mission.id, '--proof', 'free text proof', '--json']);
    assert.equal(refused.status, 2, errorText(refused));
    const text = errorText(refused);
    const short = shortRefOf(dir, taskId);
    assert.match(short, /^[A-Z0-9]{3}-\d+$/, `short id looks like what atris task prints: ${short}`);
    assert.ok(text.includes(short), `names the short task id: ${text}`);
    assert.ok(!text.includes(taskId), `does not show the long internal id: ${text}`);
    assert.match(text, new RegExp(`atris task accept ${short}`));
    assert.equal(missionFromList(dir, mission.id).status, 'planning', 'mission did not complete');
  } finally {
    cleanup(dir);
  }
});

test('mission complete lands after the linked task is accepted with a receipt', { skip: !hasNodeSqlite() }, () => {
  const dir = makeWorkspace();
  try {
    const mission = startMission(dir, 'Ship one accepted thing', ['--xp-task']);
    const taskId = mission.xp_task.task_id;

    fs.mkdirSync(path.join(dir, 'atris', 'runs'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'runs', 'receipt.md'), 'verifier exit 0\n');
    const accept = runCli(dir, ['task', 'accept', taskId, '--proof', 'ran node --test, exit 0, receipt atris/runs/receipt.md', '--as', 'keshavrao', '--json']);
    assert.equal(accept.status, 0, errorText(accept));

    const done = runCli(dir, ['mission', 'complete', mission.id, '--proof', 'accepted task receipt', '--json']);
    assert.equal(done.status, 0, errorText(done));
    const finished = missionFromList(dir, mission.id);
    assert.equal(finished.status, 'complete');
    assert.equal(finished.completion_gate.forced, false);
    assert.equal(finished.completion_gate.linked_tasks[0].task_id, taskId);
    assert.equal(finished.completion_gate.linked_tasks[0].state, 'accepted');
  } finally {
    cleanup(dir);
  }
});

test('--force is the loud, recorded override for an unaccepted linked task', { skip: !hasNodeSqlite() }, () => {
  const dir = makeWorkspace();
  try {
    const mission = startMission(dir, 'Ship one forced thing', ['--xp-task']);
    const done = runCli(dir, ['mission', 'complete', mission.id, '--proof', 'operator override', '--force', '--json']);
    assert.equal(done.status, 0, errorText(done));
    assert.match(done.stderr, /WARNING --force overrides the accepted-task gate/);
    const finished = missionFromList(dir, mission.id);
    assert.equal(finished.status, 'complete');
    assert.equal(finished.completion_gate.forced, true);
    assert.match(finished.completion_gate.forced_reason, /not accepted/);
  } finally {
    cleanup(dir);
  }
});

test('a mission with no linked task completes exactly as before', { skip: !hasNodeSqlite() }, () => {
  const dir = makeWorkspace();
  try {
    const mission = startMission(dir, 'Ship one unlinked thing');
    assert.deepEqual(mission.task_ids, []);
    const done = runCli(dir, ['mission', 'complete', mission.id, '--proof', 'human says done', '--json']);
    assert.equal(done.status, 0, errorText(done));
    const finished = missionFromList(dir, mission.id);
    assert.equal(finished.status, 'complete');
    assert.equal(finished.completion_gate.source, 'no_verifier');
  } finally {
    cleanup(dir);
  }
});

test('a passing verifier with --complete-on-pass parks a --task-linked mission ready until the task is accepted', { skip: !hasNodeSqlite() }, () => {
  const dir = makeWorkspace();
  try {
    const add = runCli(dir, ['task', 'add', 'Ship one verified thing', '--to', 'game-manager', '--json']);
    assert.equal(add.status, 0, errorText(add));
    const taskId = JSON.parse(add.stdout).task_id || JSON.parse(add.stdout).id || JSON.parse(add.stdout).task?.id;
    assert.ok(taskId, add.stdout);
    const mission = startMission(dir, 'Ship one verified thing', ['--task', taskId, '--verify', PASSING_VERIFIER, '--runner', 'manual']);
    assert.ok(mission.task_ids.includes(taskId));
    assert.equal(mission.xp_task_enabled, false, 'not an xp mission: the old path completed on verifier pass');

    const tick = runCli(dir, ['mission', 'tick', mission.id, '--verify', '--complete-on-pass', '--json', '--full']);
    assert.equal(tick.status, 0, errorText(tick));
    const ticked = JSON.parse(tick.stdout).mission;
    assert.equal(ticked.status, 'ready');
    assert.ok(ticked.next_action.includes(shortRefOf(dir, taskId)), ticked.next_action);
    assert.ok(!ticked.next_action.includes(taskId), 'no long internal id in the next action');
    assert.match(ticked.next_action, /atris task accept/);

    fs.mkdirSync(path.join(dir, 'atris', 'runs'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'runs', 'receipt.md'), 'verifier exit 0\n');
    const accept = runCli(dir, ['task', 'accept', taskId, '--proof', 'ran node --test, exit 0, receipt atris/runs/receipt.md', '--as', 'keshavrao', '--json']);
    assert.equal(accept.status, 0, errorText(accept));
    const done = runCli(dir, ['mission', 'complete', mission.id, '--proof', 'atris/runs/receipt.md', '--json']);
    assert.equal(done.status, 0, errorText(done));
    assert.equal(missionFromList(dir, mission.id).status, 'complete');
  } finally {
    cleanup(dir);
  }
});

test('a mission whose linked tasks are all archived does not complete, and says so', { skip: !hasNodeSqlite() }, () => {
  const dir = makeWorkspace();
  try {
    const mission = startMission(dir, 'Ship one archived thing', ['--xp-task']);
    const short = shortRefOf(dir, mission.xp_task.task_id);
    const archived = runCli(dir, ['task', 'archive', short, '--reason', 'swept by hand']);
    assert.equal(archived.status, 0, errorText(archived));

    const refused = runCli(dir, ['mission', 'complete', mission.id, '--proof', 'free text proof', '--json']);
    assert.equal(refused.status, 2, errorText(refused));
    assert.match(errorText(refused), /every linked task \(.*\) was archived and none was accepted/);
    assert.ok(errorText(refused).includes(short), errorText(refused));
    assert.equal(missionFromList(dir, mission.id).status, 'planning', 'mission did not complete');

    const forced = runCli(dir, ['mission', 'complete', mission.id, '--proof', 'operator override', '--force', '--json']);
    assert.equal(forced.status, 0, errorText(forced));
  } finally {
    cleanup(dir);
  }
});

test('the gate counts archived as not accepted, and skips an archived task only beside an accepted one', () => {
  const { missionLinkedTaskGate } = require('../lib/mission-task-gate');
  const rows = {
    A: { id: 'AAAAAAAAAAAA', workspace_root: '/w', status: 'archived', metadata: { approval_status: 'archived' } },
    B: { id: 'BBBBBBBBBBBB', workspace_root: '/w', status: 'done', metadata: { approval_status: 'accepted', latest_agent_proof: 'receipt' } },
  };
  const fakeDb = (ids) => ({
    open: () => ({}),
    getTask: (_db, ref) => rows[Object.keys(rows).find((key) => rows[key].id === ref)] || null,
    listTasks: () => ids.map((key) => rows[key]),
    withTaskDisplayRefs: (list) => list.map((row, index) => ({ ...row, display_id: `WRK-${index + 1}` })),
    workspaceRoot: () => '/w',
    listTaskEvents: () => [],
  });
  const onlyArchived = missionLinkedTaskGate({ task_ids: ['AAAAAAAAAAAA'] }, '/w', { taskDb: fakeDb(['A']) });
  assert.equal(onlyArchived.ok, false);
  assert.equal(onlyArchived.archived_only, true);
  assert.match(onlyArchived.reason, /WRK-1/);
  // a done task swept by clear-done keeps its accepting review in the events
  rows.C = { id: 'CCCCCCCCCCCC', workspace_root: '/w', status: 'archived', metadata: { approval_status: 'archived', archived_from: 'done', latest_agent_proof: 'receipt' } };
  rows.D = { id: 'DDDDDDDDDDDD', workspace_root: '/w', status: 'archived', metadata: { approval_status: 'archived', archived_from: 'done' } };
  const swept = (key, events) => missionLinkedTaskGate({ task_ids: [rows[key].id] }, '/w', { taskDb: { ...fakeDb([key]), listTaskEvents: () => events } });
  assert.equal(swept('C', [{ event_type: 'reviewed', payload: { reward: 3 } }]).ok, true, 'accepted then swept still counts');
  assert.equal(swept('D', [{ event_type: 'completed', payload: {} }]).ok, false, 'done but never accepted, then swept, does not');
  assert.equal(swept('C', [{ event_type: 'reviewed', payload: { reward: 0 } }]).ok, false, 'a review that rejected does not count');
  const beside = missionLinkedTaskGate({ task_ids: ['AAAAAAAAAAAA', 'BBBBBBBBBBBB'] }, '/w', { taskDb: fakeDb(['A', 'B']) });
  assert.equal(beside.ok, true);
});

test('mission complete with an unpassed check still names the linked task that is not accepted', { skip: !hasNodeSqlite() }, () => {
  const dir = makeWorkspace();
  try {
    const failing = `${process.execPath} -e "process.exit(1)"`;
    const mission = startMission(dir, 'Ship one checked thing', ['--xp-task', '--verify', failing]);
    const short = shortRefOf(dir, mission.xp_task.task_id);
    const refused = runCli(dir, ['mission', 'complete', mission.id, '--proof', 'free text proof']);
    assert.equal(refused.status, 2, errorText(refused));
    const text = errorText(refused);
    assert.match(text, /verifier has not passed/);
    assert.ok(text.includes(`linked task ${short} is`), `mentions the linked task: ${text}`);
    assert.match(text, new RegExp(`atris task accept ${short}`));
    assert.ok(!text.includes(mission.xp_task.task_id), 'no long internal id');
  } finally {
    cleanup(dir);
  }
});

test('the short id in the refusal is one atris task accept takes', { skip: !hasNodeSqlite() }, () => {
  const dir = makeWorkspace();
  try {
    const mission = startMission(dir, 'Ship one typed-id thing', ['--xp-task']);
    const short = shortRefOf(dir, mission.xp_task.task_id);
    fs.mkdirSync(path.join(dir, 'atris', 'runs'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'runs', 'receipt.md'), 'verifier exit 0\n');
    const accept = runCli(dir, ['task', 'accept', short, '--proof', 'ran node --test, exit 0, receipt atris/runs/receipt.md', '--as', 'keshavrao', '--json']);
    assert.equal(accept.status, 0, errorText(accept));
    const done = runCli(dir, ['mission', 'complete', mission.id, '--proof', 'accepted task receipt', '--json']);
    assert.equal(done.status, 0, errorText(done));
  } finally {
    cleanup(dir);
  }
});
