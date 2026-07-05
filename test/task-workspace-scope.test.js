'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

function hasNodeSqlite() {
  const result = spawnSync(process.execPath, ['-e', 'require("node:sqlite")'], {
    encoding: 'utf8',
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  });
  return result.status === 0;
}

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-task-scope-test-'));
}

function cleanupTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function runCli(args, { cwd, env } = {}) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 20000,
    env: {
      ...process.env,
      ATRIS_SKIP_UPDATE_CHECK: '1',
      ...(env || {}),
    },
  });
  if (result.error) throw result.error;
  return result;
}

test('task list --all stays in the current workspace and --everywhere spans workspaces', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const taskDb = require('../lib/task-db');
  taskDb.close();
  try {
    const ws1 = path.join(dir, 'demo-one');
    const ws2 = path.join(dir, 'demo-two');
    fs.mkdirSync(path.join(ws1, 'atris'), { recursive: true });
    fs.mkdirSync(path.join(ws2, 'atris'), { recursive: true });
    const root1 = fs.realpathSync(ws1);
    const root2 = fs.realpathSync(ws2);
    const db = taskDb.open(dbPath);
    taskDb.addTask(db, { title: 'workspace one open task', workspaceRoot: root1, status: 'open' });
    taskDb.addTask(db, { title: 'workspace one done task', workspaceRoot: root1, status: 'done' });
    taskDb.addTask(db, { title: 'workspace two open task', workspaceRoot: root2, status: 'open' });
    taskDb.close();

    const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1' };
    const allHere = runCli(['task', 'list', '--all', '--json'], { cwd: root1, env });
    assert.equal(allHere.status, 0, allHere.stderr);
    const hereTitles = JSON.parse(allHere.stdout).tasks.map((task) => task.title);
    assert.deepEqual(hereTitles.sort(), ['workspace one done task', 'workspace one open task']);

    const everywhere = runCli(['task', 'list', '--everywhere', '--json'], { cwd: root1, env });
    assert.equal(everywhere.status, 0, everywhere.stderr);
    const everywhereTitles = JSON.parse(everywhere.stdout).tasks.map((task) => task.title);
    assert.deepEqual(everywhereTitles.sort(), [
      'workspace one done task',
      'workspace one open task',
      'workspace two open task',
    ]);
  } finally {
    taskDb.close();
    cleanupTempDir(dir);
  }
});
