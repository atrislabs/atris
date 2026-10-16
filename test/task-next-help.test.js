'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTaskHelpFixture } = require('./helpers/task-help-fixture');

const { hasNodeSqlite, makeTempDir, cleanupTempDir, runCli } =
  createTaskHelpFixture('atris-task-next-help-');
const NEXT_USAGE = 'Usage: atris task next [--tag <tag>] [--create-next]';

function assertNextHelpOnly(res, label) {
  assert.equal(res.status, 0, `${label}: ${res.stdout}\n${res.stderr}`);
  const lines = String(res.stdout || '').trim().split('\n').filter(Boolean);
  assert.ok(lines.length >= 1 && lines.length <= 2, `${label} should print one usage line: ${res.stdout}`);
  assert.equal(lines[0], NEXT_USAGE, `${label}: ${res.stdout}`);
  const blob = `${res.stdout}\n${res.stderr}`;
  assert.doesNotMatch(blob, /durable local task state|Confidence Gate|TASK DESK|atris task list|say yes:/);
  assert.doesNotMatch(blob, /claimed|id required|next:|No open tasks/i);
}

test('task next --help prints one usage line and does not list or mutate', () => {
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  try {
    for (const args of [
      ['task', 'next', '--help'],
      ['task', 'next', '-h'],
      ['task', 'next', 'help'],
      ['task', 'next', '-?'],
    ]) {
      const res = runCli(args, {
        cwd: dir,
        env: { ATRIS_TASKS_DB: dbPath },
      });
      assertNextHelpOnly(res, args.join(' '));
    }
    assert.equal(fs.existsSync(dbPath), false, 'next --help must not open the task db');
    assert.equal(fs.existsSync(path.join(dir, '.atris')), false, 'next --help must not create .atris');
    assert.equal(fs.existsSync(path.join(dir, 'atris')), false, 'next --help must not scaffold atris/');
  } finally {
    cleanupTempDir(dir);
  }
});

test('task --help still prints the full task usage', () => {
  const dir = makeTempDir();
  try {
    const res = runCli(['task', '--help'], { cwd: dir });
    assert.equal(res.status, 0, `task --help: ${res.stdout}\n${res.stderr}`);
    const lines = String(res.stdout || '').trim().split('\n').filter(Boolean);
    assert.ok(lines.length > 10, `task --help should stay the encyclopedia: ${res.stdout}`);
    assert.match(res.stdout, /atris task - durable local task state/);
    assert.match(res.stdout, /atris task next \[--tag <tag>\] \[--create-next\]/);
    assert.notEqual(lines[0], NEXT_USAGE);
  } finally {
    cleanupTempDir(dir);
  }
});

test('task next <id> --help does not claim the task', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, ATRIS_AGENT_ID: 'codex' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const add = runCli(['task', 'add', 'Keep next help from taking the row', '--tag', 'cli', '--json'], {
      cwd: dir,
      env,
    });
    assert.equal(add.status, 0, add.stderr || add.stdout);
    const ref = JSON.parse(add.stdout).task.display_id;
    const before = JSON.parse(runCli(['task', 'show', ref, '--json'], { cwd: dir, env }).stdout);

    const help = runCli(['task', 'next', ref, '--help'], { cwd: dir, env });
    assertNextHelpOnly(help, `task next ${ref} --help`);

    const after = JSON.parse(runCli(['task', 'show', ref, '--json'], { cwd: dir, env }).stdout);
    assert.equal(after.status, before.status);
    assert.equal(after.updated_at, before.updated_at);
    assert.equal(after.claimed_by || after.owner || null, before.claimed_by || before.owner || null);
  } finally {
    cleanupTempDir(dir);
  }
});
