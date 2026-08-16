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
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-task-desk-ids-test-')));
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

test('task desk renders projection display_id and resolver finds task by short id case-insensitively', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const stateDir = path.join(dir, '.atris', 'state');
  fs.mkdirSync(stateDir, { recursive: true });

  const taskId = '01KZT8T264R7M5ZZ4VAXR7M5ZZ';
  const displayId = 'CLI-1259';
  const projectionPath = path.join(stateDir, 'tasks.projection.json');

  const projection = {
    schema: 'atris.task_projection.v1',
    generated_at: new Date().toISOString(),
    workspace_root: dir,
    tasks: [
      {
        id: taskId,
        display_id: displayId,
        legacy_ref: '01KZT8T2',
        title: 'Fix task desk numbers and resolution',
        status: 'open',
        tag: 'tasks',
        workspace_root: dir,
        claimed_by: null,
        created_at: Date.now(),
        updated_at: Date.now(),
        metadata: {},
        explanation: {
          what_changes: 'Desk shows projection display_id verbatim.',
          why_it_matters: 'Numbers stay stable across desk and commands.',
          done_looks_like: 'CLI-1259 is printed and resolved reliably.',
        },
      },
    ],
  };

  fs.writeFileSync(projectionPath, JSON.stringify(projection, null, 2), 'utf8');

  try {
    const env = { ATRIS_TASKS_DB: dbPath };

    // 1. Desk output must contain CLI-1259 verbatim
    const desk = runCli(['task'], { cwd: dir, env });
    assert.equal(desk.status, 0, desk.stderr);
    assert.match(desk.stdout, /TASK DESK/);
    assert.match(desk.stdout, /CLI-1259/);

    // 2. Resolver must find the task from lowercase 'cli-1259'
    const showLower = runCli(['task', 'show', 'cli-1259', '--json'], { cwd: dir, env });
    assert.equal(showLower.status, 0, showLower.stderr);
    const showLowerPayload = JSON.parse(showLower.stdout);
    assert.equal(showLowerPayload.id, taskId);
    assert.equal(showLowerPayload.display_id, displayId);

    // 3. Resolver must also find the task from uppercase 'CLI-1259'
    const showUpper = runCli(['task', 'show', 'CLI-1259', '--json'], { cwd: dir, env });
    assert.equal(showUpper.status, 0, showUpper.stderr);
    const showUpperPayload = JSON.parse(showUpper.stdout);
    assert.equal(showUpperPayload.id, taskId);
    assert.equal(showUpperPayload.display_id, displayId);

    // 4. Resolver must also find the task from legacy ref '01kzt8t2'
    const showLegacy = runCli(['task', 'show', '01kzt8t2', '--json'], { cwd: dir, env });
    assert.equal(showLegacy.status, 0, showLegacy.stderr);
    const showLegacyPayload = JSON.parse(showLegacy.stdout);
    assert.equal(showLegacyPayload.id, taskId);
    assert.equal(showLegacyPayload.display_id, displayId);
  } finally {
    cleanupTempDir(dir);
  }
});

test('task desk renders database display_id without positional recomputation when over 200 tasks exist', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const taskDb = require('../lib/task-db');
  taskDb.close();

  try {
    const db = taskDb.open(dbPath);
    const root = fs.realpathSync(dir);

    // Create 210 tasks; task #205 has display_id CLI-205 (or DIR-205)
    let targetTaskId = null;
    for (let i = 1; i <= 210; i += 1) {
      const added = taskDb.addTask(db, {
        title: `Task number ${i} in large backlog`,
        workspaceRoot: root,
        status: i === 205 ? 'open' : 'done',
      });
      if (i === 205) targetTaskId = added.id;
    }

    const env = { ATRIS_TASKS_DB: dbPath };

    // Desk must show task 205 with its true display_id
    const desk = runCli(['task'], { cwd: dir, env });
    assert.equal(desk.status, 0, desk.stderr);
    assert.match(desk.stdout, /TASK DESK/);

    const proj = JSON.parse(fs.readFileSync(path.join(dir, '.atris', 'state', 'tasks.projection.json'), 'utf8'));
    const targetTask = proj.tasks.find(t => t.id === targetTaskId);
    assert.ok(targetTask);
    assert.match(desk.stdout, new RegExp(targetTask.display_id));

    // Resolve case-insensitively
    const show = runCli(['task', 'show', targetTask.display_id.toLowerCase(), '--json'], { cwd: dir, env });
    assert.equal(show.status, 0, show.stderr);
    const showPayload = JSON.parse(show.stdout);
    assert.equal(showPayload.id, targetTaskId);
  } finally {
    cleanupTempDir(dir);
  }
});
