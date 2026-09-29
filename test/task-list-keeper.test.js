'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const taskStore = require('../lib/task-db');
const { DAY_MS, keepTaskList } = require('../lib/task-list-keeper');

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
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-task-keep-')));
  fs.mkdirSync(path.join(root, 'atris'), { recursive: true });
  return root;
}

function cleanupWorkspace(root) {
  taskStore.close();
  fs.rmSync(root, { recursive: true, force: true });
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

function age(db, id, updatedAt) {
  db.prepare('UPDATE tasks SET updated_at = ?, created_at = ? WHERE id = ?').run(updatedAt, updatedAt, id);
}

test('keepTaskList puts away finished and still work and leaves fresh work', () => {
  if (!hasNodeSqlite()) return;
  const root = makeWorkspace();
  const now = Date.now();
  try {
    const db = taskStore.open(path.join(root, 'tasks.db'));
    const fresh = taskStore.addTask(db, { title: 'Fresh open task', workspaceRoot: root }).id;
    const exactOpen = taskStore.addTask(db, { title: 'Open at the edge', workspaceRoot: root }).id;
    const oldOpen = taskStore.addTask(db, { title: 'Open too long', workspaceRoot: root }).id;
    const exactClaim = taskStore.addTask(db, {
      title: 'Claim at the edge',
      workspaceRoot: root,
      status: 'claimed',
      claimedBy: 'worker',
    }).id;
    const oldClaim = taskStore.addTask(db, {
      title: 'Claim abandoned',
      workspaceRoot: root,
      status: 'claimed',
      claimedBy: 'worker',
    }).id;
    const freshReview = taskStore.addTask(db, {
      title: 'Fresh review',
      workspaceRoot: root,
      status: 'review',
      claimedBy: 'worker',
    }).id;
    const oldReview = taskStore.addTask(db, {
      title: 'Review too long',
      workspaceRoot: root,
      status: 'review',
      claimedBy: 'worker',
    }).id;
    const recentFail = taskStore.addTask(db, {
      title: 'Recent failure',
      workspaceRoot: root,
      status: 'failed',
    }).id;
    const oldFail = taskStore.addTask(db, {
      title: 'Ancient failure',
      workspaceRoot: root,
      status: 'failed',
    }).id;
    const finished = taskStore.addTask(db, { title: 'Finished task', workspaceRoot: root }).id;
    assert.equal(taskStore.doneTask(db, { id: finished, status: 'done', actor: 'tester', proof: 'done' }).updated, true);

    age(db, exactOpen, now - (14 * DAY_MS));
    age(db, oldOpen, now - (14 * DAY_MS) - 1000);
    age(db, exactClaim, now - (3 * DAY_MS));
    age(db, oldClaim, now - (3 * DAY_MS) - 1000);
    age(db, oldReview, now - (14 * DAY_MS) - 1000);
    age(db, recentFail, now - (8 * DAY_MS));
    age(db, oldFail, now - (30 * DAY_MS) - 1000);

    const result = keepTaskList(db, { workspaceRoot: root, actor: 'tester', now, missions: [] });
    const gone = new Set(result.put_away.map(row => row.id));
    assert.equal(gone.has(fresh), false);
    assert.equal(gone.has(exactOpen), false);
    assert.equal(gone.has(exactClaim), false);
    assert.equal(gone.has(freshReview), false);
    assert.equal(gone.has(recentFail), false);
    for (const id of [oldOpen, oldClaim, oldReview, oldFail, finished]) {
      assert.equal(gone.has(id), true, id);
      assert.equal(taskStore.getTask(db, id).status, 'archived');
    }
    assert.equal(taskStore.getTask(db, fresh).status, 'open');
    assert.equal(taskStore.getTask(db, recentFail).status, 'failed');
  } finally {
    cleanupWorkspace(root);
  }
});

test('keepTaskList ignores archived history and a live blocker with no stopped mission', () => {
  if (!hasNodeSqlite()) return;
  const root = makeWorkspace();
  try {
    const db = taskStore.open(path.join(root, 'tasks.db'));
    const fresh = taskStore.addTask(db, { title: 'Still live', workspaceRoot: root }).id;
    const blocker = taskStore.addTask(db, {
      title: 'Blocker for a live mission',
      workspaceRoot: root,
      tag: 'mission-blocker',
      metadata: { mission_id: 'mission-live', mission_blocker_class: 'runner-failed' },
    }).id;
    for (let index = 0; index < 50; index += 1) {
      const old = taskStore.addTask(db, { title: `Old history ${index}`, workspaceRoot: root }).id;
      taskStore.archiveTask(db, { id: old, actor: 'tester', reason: 'already off the list', skipLogs: true });
    }
    const result = keepTaskList(db, { workspaceRoot: root, actor: 'tester', missions: [] });
    assert.equal(result.put_away.length, 0);
    assert.equal(result.reaped.length, 0);
    assert.equal(taskStore.getTask(db, fresh).status, 'open');
    assert.equal(taskStore.getTask(db, blocker).status, 'open');
  } finally {
    cleanupWorkspace(root);
  }
});

test('keepTaskList closes a blocker when its mission has stopped', () => {
  if (!hasNodeSqlite()) return;
  const root = makeWorkspace();
  try {
    const db = taskStore.open(path.join(root, 'tasks.db'));
    const blocker = taskStore.addTask(db, {
      title: 'Unblock a stopped mission',
      workspaceRoot: root,
      tag: 'mission-blocker',
      metadata: { mission_id: 'mission-stopped', mission_blocker_class: 'runner-failed' },
    }).id;
    const result = keepTaskList(db, {
      workspaceRoot: root,
      actor: 'tester',
      missions: [{ id: 'mission-stopped', status: 'stopped' }],
    });
    assert.equal(result.reaped.length, 1);
    assert.equal(result.reaped[0].task_id, blocker);
    assert.equal(taskStore.getTask(db, blocker).status, 'archived');
  } finally {
    cleanupWorkspace(root);
  }
});

test('task keep and boot refresh the list people see', () => {
  if (!hasNodeSqlite()) return;
  const root = makeWorkspace();
  const dbPath = path.join(root, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath };
  try {
    const db = taskStore.open(dbPath);
    const fresh = taskStore.addTask(db, { title: 'Fresh open task', workspaceRoot: root }).id;
    const finished = taskStore.addTask(db, { title: 'Finished task', workspaceRoot: root }).id;
    assert.equal(taskStore.doneTask(db, { id: finished, status: 'done', actor: 'tester', proof: 'done' }).updated, true);
    taskStore.close();

    const kept = runCli(['task', 'keep', '--json'], { cwd: root, env });
    assert.equal(kept.status, 0, kept.stderr);
    const payload = JSON.parse(kept.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.count, 1);
    assert.equal(payload.put_away[0].id, finished);

    const todo = fs.readFileSync(path.join(root, 'atris', 'TODO.md'), 'utf8');
    assert.match(todo, /Fresh open task/);
    assert.doesNotMatch(todo, /Finished task/);

    const again = runCli(['task', 'keep'], { cwd: root, env });
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /task list is current/);

    const day = runCli(['task', 'day'], { cwd: root, env });
    assert.equal(day.status, 0, day.stderr);
    assert.match(day.stdout, /Fresh open task/);
    assert.doesNotMatch(day.stdout, /Finished task/);

    const boot = runCli(['atris.md'], { cwd: root, env });
    assert.equal(boot.status, 0, boot.stderr);
    assert.match(boot.stdout, /Fresh open task/);
    assert.doesNotMatch(boot.stdout, /Finished task/);
    assert.doesNotMatch(boot.stdout, /put away/);

    const dbAfter = taskStore.open(dbPath);
    assert.equal(taskStore.getTask(dbAfter, fresh).status, 'open');
    assert.equal(taskStore.getTask(dbAfter, finished).status, 'archived');
  } finally {
    cleanupWorkspace(root);
  }
});
