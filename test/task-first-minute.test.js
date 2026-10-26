'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  hasNodeSqlite, makeTempDir: makeFixtureDir, cleanupTempDir,
  runCli, taskEnv, nextLine,
} = require('./helpers/task-next-fixture');
const makeTempDir = () => makeFixtureDir('atris-task-first-minute-');
const { spokenLineCount } = require('../lib/first-minute');

function writeReadyWorkspace(dir, tasks) {
  fs.mkdirSync(path.join(dir, 'atris', 'reports'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.atris', 'state'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'atris', 'MAP.md'), '# MAP.md\n\n## By-Feature\n- example: bin/atris.js:1\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'atris', 'TODO.md'), '# TODO.md\n\n## Backlog\n\n(Empty)\n', 'utf8');
  fs.writeFileSync(path.join(dir, '.atris', 'state', 'tasks.projection.json'), JSON.stringify({
    schema: 'atris.task_projection.v1',
    tasks,
  }, null, 2), 'utf8');
}

test('default atris task in an empty folder talks like first-minute', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  try {
    const env = taskEnv(dir, 'fresh.db');
    const minute = runCli([], { cwd: dir, env });
    const task = runCli(['task'], { cwd: dir, env });
    assert.equal(minute.status, 0, minute.stderr || minute.stdout);
    assert.equal(task.status, 0, task.stderr || task.stdout);
    assert.equal(task.stdout.trim(), minute.stdout.trim());
    assert.match(task.stdout, /this folder is empty/);
    assert.equal(nextLine(task.stdout), 'atris "what do you want here?"');
    assert.ok(spokenLineCount(task.stdout) <= 4);
    assert.doesNotMatch(task.stdout, /No open tasks|atris task new|TASK DESK/);
    assert.equal(fs.existsSync(path.join(dir, 'atris')), false);
  } finally {
    cleanupTempDir(dir);
  }
});

test('default atris task is short and names the same next as bare atris', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  try {
    writeReadyWorkspace(dir, [{
      id: 'task-1',
      display_id: 'CLI-9',
      title: 'Ship the landing page',
      status: 'claimed',
      claimed_by: 'keshav',
      updated_at: 30,
    }]);
    const env = taskEnv(dir, 'claimed.db');
    const bare = runCli([], { cwd: dir, env });
    const task = runCli(['task'], { cwd: dir, env });
    assert.equal(bare.status, 0, bare.stderr || bare.stdout);
    assert.equal(task.status, 0, task.stderr || task.stdout);
    assert.equal(nextLine(task.stdout), nextLine(bare.stdout));
    assert.equal(nextLine(task.stdout), 'atris "add a test for the claimed task"');
    assert.ok(spokenLineCount(task.stdout) <= 4);
    assert.doesNotMatch(task.stdout, /TASK DESK|Why it matters|What changes|Done looks like/);
    assert.doesNotMatch(task.stdout, /Describe the desired outcome|say yes:/i);
  } finally {
    cleanupTempDir(dir);
  }
});

test('task desk and task --all still print the long desk', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  try {
    writeReadyWorkspace(dir, [{
      id: 'task-1',
      display_id: 'CLI-9',
      title: 'Ship the landing page',
      status: 'claimed',
      claimed_by: 'keshav',
      updated_at: 30,
    }]);
    const env = taskEnv(dir, 'desk.db');
    const desk = runCli(['task', 'desk'], { cwd: dir, env });
    const all = runCli(['task', '--all'], { cwd: dir, env });
    assert.equal(desk.status, 0, desk.stderr || desk.stdout);
    assert.equal(all.status, 0, all.stderr || all.stdout);
    assert.match(desk.stdout, /TASK DESK/);
    assert.match(all.stdout, /TASK DESK/);
    assert.match(desk.stdout, /Why it matters/);
    assert.match(all.stdout, /Why it matters/);
    assert.equal(nextLine(desk.stdout), 'atris "add a test for the claimed task"');
    assert.equal(nextLine(all.stdout), 'atris "add a test for the claimed task"');
  } finally {
    cleanupTempDir(dir);
  }
});
