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

function makeWorkspace() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-clear-done-test-')));
  fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'atris', 'TODO.md'), [
    '# TODO.md',
    '',
    '## Backlog',
    '',
    '(Empty)',
    '',
    '## In Progress',
    '',
    '(Empty)',
    '',
    '## Review',
    '',
    '(Empty)',
    '',
    '## Completed',
    '',
    '(Empty)',
    '',
  ].join('\n'), 'utf8');
  return dir;
}

function cleanupWorkspace(dir) {
  taskStore.close();
  fs.rmSync(dir, { recursive: true, force: true });
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

function addDoneTask(db, dir, title, completedAt) {
  const created = taskStore.addTask(db, {
    title,
    tag: 'clear-done-test',
    workspaceRoot: dir,
  });
  const done = taskStore.doneTask(db, {
    id: created.id,
    status: 'done',
    actor: 'tester',
    proof: `verified ${title}`,
  });
  assert.equal(done.updated, true);
  db.prepare('UPDATE tasks SET done_at = ?, updated_at = ? WHERE id = ?')
    .run(completedAt, completedAt, created.id);
  return created.id;
}

test('task clear-done archives completed rows oldest first and leaves active rows', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeWorkspace();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, ATRIS_AGENT_ID: 'codex' };
  try {
    const db = taskStore.open(dbPath);
    const olderAt = Date.now() - 20 * 24 * 60 * 60 * 1000;
    const newerAt = Date.now() - 2 * 24 * 60 * 60 * 1000;
    const olderId = addDoneTask(db, dir, 'Old completed task', olderAt);
    const newerId = addDoneTask(db, dir, 'New completed task', newerAt);
    const openId = taskStore.addTask(db, {
      title: 'Open task stays visible',
      tag: 'clear-done-test',
      workspaceRoot: dir,
    }).id;
    const reviewId = taskStore.addTask(db, {
      title: 'Review task stays visible',
      tag: 'clear-done-test',
      workspaceRoot: dir,
      status: 'review',
      claimedBy: 'tester',
    }).id;
    taskStore.close();

    const swept = runCli(['task', 'clear-done', '--json'], { cwd: dir, env });
    assert.equal(swept.status, 0, swept.stderr);
    const payload = JSON.parse(swept.stdout);
    assert.equal(payload.count, 2);
    assert.deepEqual(payload.sample.map(row => row.title), ['Old completed task', 'New completed task']);
    assert.equal(payload.reason, 'cleared by clear-done sweep');

    const checkedDb = taskStore.open(dbPath);
    const older = taskStore.getTask(checkedDb, olderId);
    const newer = taskStore.getTask(checkedDb, newerId);
    assert.equal(older.status, 'archived');
    assert.equal(newer.status, 'archived');
    assert.equal(older.done_at, olderAt);
    assert.equal(older.metadata.archived_from, 'done');
    assert.equal(older.metadata.archived_reason, 'cleared by clear-done sweep');
    assert.equal(taskStore.getTask(checkedDb, openId).status, 'open');
    assert.equal(taskStore.getTask(checkedDb, reviewId).status, 'review');
    const eventTypes = taskStore.listTaskEvents(checkedDb, { taskId: olderId, limit: 20 })
      .map(event => event.event_type);
    assert.ok(eventTypes.includes('completed'));
    assert.ok(eventTypes.includes('archived'));
    taskStore.close();

    const todo = fs.readFileSync(path.join(dir, 'atris', 'TODO.md'), 'utf8');
    assert.match(todo, /Open task stays visible/);
    assert.match(todo, /Review task stays visible/);
    assert.doesNotMatch(todo, /Old completed task|New completed task/);
  } finally {
    cleanupWorkspace(dir);
  }
});

test('task clear-done dry-run reports a sample and changes nothing', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeWorkspace();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, ATRIS_AGENT_ID: 'codex' };
  try {
    const db = taskStore.open(dbPath);
    const doneId = addDoneTask(db, dir, 'Dry-run completed task', Date.now() - 10_000);
    const eventsBefore = taskStore.listTaskEvents(db, { taskId: doneId, limit: 20 }).length;
    taskStore.close();
    const todoPath = path.join(dir, 'atris', 'TODO.md');
    const todoBefore = fs.readFileSync(todoPath, 'utf8');
    const projectionPath = path.join(dir, '.atris', 'state', 'tasks.projection.json');
    assert.equal(fs.existsSync(projectionPath), false);

    const humanPreview = runCli(['task', 'clear-done', '--dry-run'], { cwd: dir, env });
    assert.equal(humanPreview.status, 0, humanPreview.stderr);
    assert.match(humanPreview.stdout, /clear-done dry-run: 1 completed task\(s\) would be archived\./);
    assert.match(humanPreview.stdout, /Dry-run completed task/);

    const preview = runCli(['task', 'clear-done', '--dry-run', '--json'], { cwd: dir, env });
    assert.equal(preview.status, 0, preview.stderr);
    const payload = JSON.parse(preview.stdout);
    assert.equal(payload.dry_run, true);
    assert.equal(payload.count, 1);
    assert.equal(payload.sample[0].title, 'Dry-run completed task');

    const checkedDb = taskStore.open(dbPath);
    assert.equal(taskStore.getTask(checkedDb, doneId).status, 'done');
    assert.equal(taskStore.listTaskEvents(checkedDb, { taskId: doneId, limit: 20 }).length, eventsBefore);
    taskStore.close();
    assert.equal(fs.readFileSync(todoPath, 'utf8'), todoBefore);
    assert.equal(fs.existsSync(projectionPath), false);
  } finally {
    cleanupWorkspace(dir);
  }
});

test('task clear-done before filter drops only old completed rows from status', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeWorkspace();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, ATRIS_AGENT_ID: 'codex' };
  try {
    const db = taskStore.open(dbPath);
    const oldId = addDoneTask(db, dir, 'Old enough to clear', Date.now() - 10 * 24 * 60 * 60 * 1000);
    const recentId = addDoneTask(db, dir, 'Recent completed task stays', Date.now() - 24 * 60 * 60 * 1000);
    taskStore.close();

    const before = runCli(['status', '--json'], { cwd: dir, env });
    assert.equal(before.status, 0, before.stderr);
    assert.equal(JSON.parse(before.stdout).completed.length, 2);

    const swept = runCli(['task', 'clear-done', '--before', '5', '--json'], { cwd: dir, env });
    assert.equal(swept.status, 0, swept.stderr);
    const sweptPayload = JSON.parse(swept.stdout);
    assert.equal(sweptPayload.count, 1);
    assert.equal(sweptPayload.sample[0].title, 'Old enough to clear');

    const after = runCli(['status', '--json'], { cwd: dir, env });
    assert.equal(after.status, 0, after.stderr);
    assert.deepEqual(JSON.parse(after.stdout).completed.map(row => row.title), ['Recent completed task stays']);

    const checkedDb = taskStore.open(dbPath);
    assert.equal(taskStore.getTask(checkedDb, oldId).status, 'archived');
    assert.equal(taskStore.getTask(checkedDb, recentId).status, 'done');
    taskStore.close();
    const todo = fs.readFileSync(path.join(dir, 'atris', 'TODO.md'), 'utf8');
    assert.doesNotMatch(todo, /Old enough to clear/);
    assert.match(todo, /Recent completed task stays/);
  } finally {
    cleanupWorkspace(dir);
  }
});
