'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTaskHelpFixture } = require('./helpers/task-help-fixture');

const { hasNodeSqlite, makeTempDir, cleanupTempDir, runCli } =
  createTaskHelpFixture('atris-task-accept-help-');
const ACCEPT_USAGE = 'Usage: atris task accept <id> [--proof "..."] [--public]';

function assertAcceptHelpOnly(res, label) {
  assert.equal(res.status, 0, `${label}: ${res.stdout}\n${res.stderr}`);
  const lines = String(res.stdout || '').trim().split('\n').filter(Boolean);
  assert.ok(lines.length >= 1 && lines.length <= 2, `${label} should print one usage line: ${res.stdout}`);
  assert.equal(lines[0], ACCEPT_USAGE, `${label}: ${res.stdout}`);
  const blob = `${res.stdout}\n${res.stderr}`;
  assert.doesNotMatch(blob, /durable local task state|Confidence Gate|TASK DESK|atris task list|atris task claim|say yes:/);
  assert.doesNotMatch(blob, /accepted|id required|proof required/i);
}

test('task accept --help prints one usage line and does not list or mutate', () => {
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  try {
    for (const args of [
      ['task', 'accept', '--help'],
      ['task', 'accept', '-h'],
      ['task', 'accept', 'help'],
      ['task', 'accept', '-?'],
    ]) {
      const res = runCli(args, {
        cwd: dir,
        env: { ATRIS_TASKS_DB: dbPath },
      });
      assertAcceptHelpOnly(res, args.join(' '));
    }
    assert.equal(fs.existsSync(dbPath), false, 'accept --help must not open the task db');
    assert.equal(fs.existsSync(path.join(dir, '.atris')), false, 'accept --help must not create .atris');
    assert.equal(fs.existsSync(path.join(dir, 'atris')), false, 'accept --help must not scaffold atris/');
  } finally {
    cleanupTempDir(dir);
  }
});

test('task accept <id> --help does not accept the task', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, ATRIS_AGENT_ID: 'codex' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const add = runCli(['task', 'add', 'Keep accept help from saying yes', '--tag', 'cli', '--json'], {
      cwd: dir,
      env,
    });
    assert.equal(add.status, 0, add.stderr || add.stdout);
    const ref = JSON.parse(add.stdout).task.display_id;
    const before = JSON.parse(runCli(['task', 'show', ref, '--json'], { cwd: dir, env }).stdout);

    const help = runCli(['task', 'accept', ref, '--help'], { cwd: dir, env });
    assertAcceptHelpOnly(help, `task accept ${ref} --help`);

    const after = JSON.parse(runCli(['task', 'show', ref, '--json'], { cwd: dir, env }).stdout);
    assert.equal(after.status, before.status);
    assert.equal(after.updated_at, before.updated_at);
  } finally {
    cleanupTempDir(dir);
  }
});
