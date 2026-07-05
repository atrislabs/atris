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
const CLEAN_RESULT = 'Operators can now read the whole team day on one page instead of scrolling raw logs.';
const PROOF = 'node --test test/task-result-gate.test.js passed and the task projection was inspected.';

function hasNodeSqlite() {
  const result = spawnSync(process.execPath, ['-e', 'require("node:sqlite")'], {
    encoding: 'utf8',
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  });
  return result.status === 0;
}

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-task-result-gate-'));
}

function cleanupTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function envFor(dir) {
  return {
    ...scrubAgentEnv(),
    ATRIS_SKIP_UPDATE_CHECK: '1',
    ATRIS_TASKS_DB: path.join(dir, 'tasks.db'),
    NODE_NO_WARNINGS: '1',
  };
}

function runCli(args, { cwd, env } = {}) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 20000,
    env: env || envFor(cwd),
  });
  if (result.error) throw result.error;
  return result;
}

function createClaimedTask(dir, env, title = 'Operators save time because completed work gets explained') {
  const created = runCli(['task', 'new', title, '--tag', 'result', '--json'], { cwd: dir, env });
  assert.equal(created.status, 0, created.stderr || created.stdout);
  const task = JSON.parse(created.stdout).task;
  const claimed = runCli(['task', 'claim', task.display_id, '--as', 'codex'], { cwd: dir, env });
  assert.equal(claimed.status, 0, claimed.stderr || claimed.stdout);
  return task;
}

function readProjection(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, '.atris', 'state', 'tasks.projection.json'), 'utf8'));
}

test('task ready requires a day-one PM result sentence', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const env = envFor(dir);
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const task = createClaimedTask(dir, env);
    const ready = runCli(['task', 'ready', task.display_id, '--proof', PROOF, '--as', 'codex'], { cwd: dir, env });
    assert.notEqual(ready.status, 0);
    assert.match(ready.stderr, /needs --result/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('task ready rejects jargony result sentences', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const env = envFor(dir);
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const task = createClaimedTask(dir, env);
    const ready = runCli([
      'task', 'ready', task.display_id,
      '--proof', PROOF,
      '--result', 'Operators can now inspect commands/task.js with --flags because users save time.',
      '--as', 'codex',
    ], { cwd: dir, env });
    assert.notEqual(ready.status, 0);
    assert.match(ready.stderr, /needs --result/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('task ready stores a clean result sentence in the projection', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const env = envFor(dir);
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const task = createClaimedTask(dir, env);
    const ready = runCli([
      'task', 'ready', task.display_id,
      '--proof', PROOF,
      '--result', CLEAN_RESULT,
      '--as', 'codex',
      '--json',
    ], { cwd: dir, env });
    assert.equal(ready.status, 0, ready.stderr || ready.stdout);
    const projectionTask = readProjection(dir).tasks.find((item) => item.display_id === task.display_id);
    assert.equal(projectionTask.result, CLEAN_RESULT);
    assert.equal(projectionTask.metadata.result, CLEAN_RESULT);
    assert.equal(projectionTask.review.landing.happened, CLEAN_RESULT);
  } finally {
    cleanupTempDir(dir);
  }
});

test('task result backfills the result sentence on an existing task', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const env = envFor(dir);
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const created = runCli(['task', 'new', 'Operators save time because old tasks can be explained', '--tag', 'result', '--json'], { cwd: dir, env });
    assert.equal(created.status, 0, created.stderr || created.stdout);
    const task = JSON.parse(created.stdout).task;
    const result = runCli(['task', 'result', task.display_id, CLEAN_RESULT, '--json'], { cwd: dir, env });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const projectionTask = readProjection(dir).tasks.find((item) => item.display_id === task.display_id);
    assert.equal(projectionTask.result, CLEAN_RESULT);
    assert.equal(projectionTask.metadata.result, CLEAN_RESULT);
  } finally {
    cleanupTempDir(dir);
  }
});
