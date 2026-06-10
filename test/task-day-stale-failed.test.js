'use strict';

// task day must stop renting daily rows to long-dead failed tasks:
// failed >7d collapses into one stale summary line; fresh failures stay visible.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');
const { taskDayGroups } = require('../commands/task');

const DAY_MS = 24 * 60 * 60 * 1000;

function hasNodeSqlite() {
  const result = spawnSync(process.execPath, ['-e', 'require("node:sqlite")'], {
    encoding: 'utf8',
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  });
  return result.status === 0;
}

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-task-day-stale-test-'));
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

function fakeTask(overrides = {}) {
  return {
    id: overrides.id || 'task-x',
    display_id: overrides.display_id || 'TST-1',
    title: overrides.title || 'A task',
    status: overrides.status || 'open',
    claimed_by: overrides.claimed_by || null,
    updated_at: overrides.updated_at || Date.now(),
    ...overrides,
  };
}

test('taskDayGroups hides failed tasks older than 7 days behind staleFailed', () => {
  const now = Date.now();
  const { groups, staleFailed } = taskDayGroups([
    fakeTask({ id: 'a', display_id: 'TST-1', status: 'open', title: 'Open task' }),
    fakeTask({ id: 'b', display_id: 'TST-2', status: 'failed', title: 'Fresh failure', updated_at: now - DAY_MS }),
    fakeTask({ id: 'c', display_id: 'TST-3', status: 'failed', title: 'Ancient failure', updated_at: now - (8 * DAY_MS) }),
    fakeTask({ id: 'd', display_id: 'TST-4', status: 'done', title: 'Done task' }),
  ], { now });

  const visibleIds = groups.flatMap((group) => group.tasks.map((task) => task.id));
  assert.ok(visibleIds.includes('a'), 'open task stays visible');
  assert.ok(visibleIds.includes('b'), 'fresh failed task stays visible');
  assert.ok(!visibleIds.includes('c'), 'stale failed task leaves the day groups');
  assert.ok(!visibleIds.includes('d'), 'done tasks never appear');
  assert.equal(staleFailed.length, 1);
  assert.equal(staleFailed[0].id, 'c');
});

test('taskDayGroups keeps failed task visible exactly at the boundary', () => {
  const now = Date.now();
  const { groups, staleFailed } = taskDayGroups([
    fakeTask({ id: 'edge', status: 'failed', updated_at: now - (7 * DAY_MS) }),
  ], { now });
  assert.equal(staleFailed.length, 0);
  assert.equal(groups[0].tasks[0].id, 'edge');
});

test('task day CLI collapses stale failed rows into one summary line', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const created = runCli(['task', 'new', 'Doomed old task', '--tag', 'stale-test', '--json'], { cwd: dir, env });
    assert.equal(created.status, 0, created.stderr);
    const doomed = JSON.parse(created.stdout).task;
    assert.equal(runCli(['task', 'claim', doomed.display_id, '--as', 'codex'], { cwd: dir, env }).status, 0);
    assert.equal(runCli(['task', 'done', doomed.display_id, '--failed', '--as', 'codex'], { cwd: dir, env }).status, 0);

    const fresh = runCli(['task', 'new', 'Live open task', '--tag', 'stale-test', '--json'], { cwd: dir, env });
    assert.equal(fresh.status, 0, fresh.stderr);

    // Age the failed task past the 7-day window.
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(dbPath);
    db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(Date.now() - (8 * DAY_MS), doomed.id);
    db.close();

    const day = runCli(['task', 'day'], { cwd: dir, env });
    assert.equal(day.status, 0, day.stderr);
    assert.doesNotMatch(day.stdout, /Doomed old task/);
    assert.match(day.stdout, /Live open task/);
    assert.match(day.stdout, /stale\s+1 failed >7d hidden — atris task list --status failed/);

    const dayJson = runCli(['task', 'day', '--json'], { cwd: dir, env });
    assert.equal(dayJson.status, 0, dayJson.stderr);
    const payload = JSON.parse(dayJson.stdout);
    assert.equal(payload.counts.stale_failed, 1);
    assert.deepEqual(payload.stale_failed.refs, [doomed.display_id]);
  } finally {
    cleanupTempDir(dir);
  }
});

test('task day CLI keeps fresh failed tasks visible without a stale line', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const env = { ATRIS_TASKS_DB: path.join(dir, 'tasks.db'), NODE_NO_WARNINGS: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const created = runCli(['task', 'new', 'Just failed task', '--tag', 'stale-test', '--json'], { cwd: dir, env });
    assert.equal(created.status, 0, created.stderr);
    const task = JSON.parse(created.stdout).task;
    assert.equal(runCli(['task', 'claim', task.display_id, '--as', 'codex'], { cwd: dir, env }).status, 0);
    assert.equal(runCli(['task', 'done', task.display_id, '--failed', '--as', 'codex'], { cwd: dir, env }).status, 0);

    const day = runCli(['task', 'day'], { cwd: dir, env });
    assert.equal(day.status, 0, day.stderr);
    assert.match(day.stdout, /Just failed task/);
    assert.doesNotMatch(day.stdout, /failed >7d hidden/);
  } finally {
    cleanupTempDir(dir);
  }
});
