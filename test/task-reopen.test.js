'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const taskStore = require('../lib/task-db');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

function hasNodeSqlite() {
  const result = spawnSync(process.execPath, ['-e', 'require("node:sqlite")'], {
    encoding: 'utf8',
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  });
  return result.status === 0;
}

function runCli(args, { cwd, env }) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 30000,
    env: {
      ...process.env,
      ATRIS_SKIP_UPDATE_CHECK: '1',
      NODE_NO_WARNINGS: '1',
      ...env,
    },
  });
  if (result.error) throw result.error;
  return result;
}

function withTask(fn) {
  if (!hasNodeSqlite()) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-task-reopen-test-'));
  const env = {
    ATRIS_TASKS_DB: path.join(dir, 'tasks.db'),
    ATRIS_AGENT_PROOF_ONLY: '0',
  };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const created = runCli(['task', 'new', 'Send finished work back to open', '--json'], { cwd: dir, env });
    assert.equal(created.status, 0, created.stderr);
    fn({ dir, env, task: JSON.parse(created.stdout).task });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function finish(env, task, status) {
  const db = taskStore.open(env.ATRIS_TASKS_DB);
  const result = taskStore.doneTask(db, { id: task.id, status, actor: 'tester', proof: 'checked by hand' });
  assert.equal(result.updated, true);
}

function show(dir, env, id) {
  const shown = runCli(['task', 'show', id, '--json'], { cwd: dir, env });
  assert.equal(shown.status, 0, shown.stderr);
  return JSON.parse(shown.stdout);
}

test('atris task reopen sends a done task back to open', () => {
  withTask(({ dir, env, task }) => {
    finish(env, task, 'done');
    assert.equal(show(dir, env, task.display_id).status, 'done');

    const result = runCli(['task', 'reopen', task.display_id, '--reason', 'the fix did not hold', '--json'], { cwd: dir, env });
    assert.equal(result.status, 0, result.stderr);
    const body = JSON.parse(result.stdout);
    assert.equal(body.ok, true);
    assert.equal(body.action, 'reopened');
    assert.equal(body.reopened_from, 'done');

    const after = show(dir, env, task.display_id);
    assert.equal(after.status, 'open');
    assert.ok(!after.claimed_by, 'reopened task should not keep its old owner');
  });
});

test('atris task reopen lets the job be claimed again', () => {
  withTask(({ dir, env, task }) => {
    finish(env, task, 'failed');
    const reopened = runCli(['task', 'reopen', task.display_id], { cwd: dir, env });
    assert.equal(reopened.status, 0, reopened.stderr);
    assert.match(reopened.stdout, /reopened .*\(was failed\)/);

    const reclaimed = runCli(['task', 'claim', task.display_id, '--as', 'second-try'], { cwd: dir, env });
    assert.equal(reclaimed.status, 0, reclaimed.stderr);
    assert.equal(show(dir, env, task.display_id).claimed_by, 'second-try');
  });
});

test('atris task reopen refuses a task that is already open', () => {
  withTask(({ dir, env, task }) => {
    const result = runCli(['task', 'reopen', task.display_id, '--json'], { cwd: dir, env });
    assert.equal(result.status, 1);
    const body = JSON.parse(result.stdout);
    assert.equal(body.ok, false);
    assert.equal(body.reason, 'already_open');
    assert.equal(show(dir, env, task.display_id).status, 'open');
  });
});

test('atris task reopen requires a task id', () => {
  withTask(({ dir, env }) => {
    const result = runCli(['task', 'reopen'], { cwd: dir, env });
    assert.notEqual(result.status, 0);
  });
});
