'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTaskHelpFixture } = require('./helpers/task-help-fixture');
const { hasNodeSqlite, makeTempDir, cleanupTempDir, runCli } = createTaskHelpFixture('atris-task-step-help-');

const STEP_USAGE = 'Usage: atris task step <id> [--json]';

function assertStepHelpOnly(res, label) {
  assert.equal(res.status, 0, `${label}: ${res.stdout}\n${res.stderr}`);
  const lines = String(res.stdout || '').trim().split('\n').filter(Boolean);
  assert.ok(lines.length >= 1 && lines.length <= 2, `${label} should print one usage line: ${res.stdout}`);
  assert.equal(lines[0], STEP_USAGE, `${label}: ${res.stdout}`);
  const blob = `${res.stdout}\n${res.stderr}`;
  assert.doesNotMatch(blob, /durable local task state|Confidence Gate|TASK DESK|atris task list|atris task accept|say yes:/);
  assert.doesNotMatch(blob, /id required|no safe agent|missing_id|step:/i);
}

test('task step --help prints one usage line and does not list or mutate', () => {
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  try {
    for (const args of [
      ['task', 'step', '--help'],
      ['task', 'step', '-h'],
      ['task', 'step', 'help'],
      ['task', 'step', '-?'],
    ]) {
      const res = runCli(args, {
        cwd: dir,
        env: { ATRIS_TASKS_DB: dbPath },
      });
      assertStepHelpOnly(res, args.join(' '));
    }
    assert.equal(fs.existsSync(dbPath), false, 'step --help must not open the task db');
    assert.equal(fs.existsSync(path.join(dir, '.atris')), false, 'step --help must not create .atris');
    assert.equal(fs.existsSync(path.join(dir, 'atris')), false, 'step --help must not scaffold atris/');
  } finally {
    cleanupTempDir(dir);
  }
});

test('task step <id> --help does not step the task', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, ATRIS_AGENT_ID: 'codex' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const add = runCli(['task', 'add', 'Keep step help from advancing the row', '--tag', 'cli', '--json'], {
      cwd: dir,
      env,
    });
    assert.equal(add.status, 0, add.stderr || add.stdout);
    const ref = JSON.parse(add.stdout).task.display_id;
    const before = JSON.parse(runCli(['task', 'show', ref, '--json'], { cwd: dir, env }).stdout);

    const help = runCli(['task', 'step', ref, '--help'], { cwd: dir, env });
    assertStepHelpOnly(help, `task step ${ref} --help`);

    const after = JSON.parse(runCli(['task', 'show', ref, '--json'], { cwd: dir, env }).stdout);
    assert.equal(after.status, before.status);
    assert.equal(after.updated_at, before.updated_at);
  } finally {
    cleanupTempDir(dir);
  }
});
