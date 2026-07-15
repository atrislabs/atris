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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-task-retitle-test-'));
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
  const dir = makeTempDir();
  const env = {
    ATRIS_TASKS_DB: path.join(dir, 'tasks.db'),
    ATRIS_AGENT_PROOF_ONLY: '0',
  };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const created = runCli(['task', 'new', 'Original task title', '--json'], { cwd: dir, env });
    assert.equal(created.status, 0, created.stderr);
    fn({ dir, env, task: JSON.parse(created.stdout).task });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('atris task retitle changes the task title', () => {
  withTask(({ dir, env, task }) => {
    const result = runCli(['task', 'retitle', task.display_id, 'Help operators find current work faster'], { cwd: dir, env });
    assert.equal(result.status, 0, result.stderr);
    const shown = runCli(['task', 'show', task.display_id, '--json'], { cwd: dir, env });
    assert.equal(shown.status, 0, shown.stderr);
    assert.equal(JSON.parse(shown.stdout).title, 'Help operators find current work faster');
  });
});

test('atris task retitle preserves the old title in task dialogue', () => {
  withTask(({ dir, env, task }) => {
    const result = runCli(['task', 'retitle', task.display_id, 'Help operators see the next task clearly'], { cwd: dir, env });
    assert.equal(result.status, 0, result.stderr);
    const shown = JSON.parse(runCli(['task', 'show', task.display_id, '--json'], { cwd: dir, env }).stdout);
    assert.ok(shown.messages.some(message => message.content === 'previous title: Original task title'));
  });
});

test('atris task retitle rejects an empty title', () => {
  withTask(({ dir, env, task }) => {
    const result = runCli(['task', 'retitle', task.display_id, '', '--json'], { cwd: dir, env });
    assert.notEqual(result.status, 0);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, false);
    assert.equal(payload.reason, 'missing_title');
  });
});

test('atris task retitle --json returns the new title', () => {
  withTask(({ dir, env, task }) => {
    const newTitle = 'Help reviewers understand task scope faster';
    const result = runCli(['task', 'retitle', task.display_id, newTitle, '--json'], { cwd: dir, env });
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.action, 'retitled');
    assert.equal(payload.title, newTitle);
    assert.equal(payload.task.title, newTitle);
  });
});
