'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const taskStore = require('../lib/task-db');
const { DAY_MS, keepTaskList } = require('../lib/task-list-keeper');
const { hasNodeSqlite: probeNodeSqlite } = require('./helpers/node-sqlite');
const hasNodeSqlite = () => probeNodeSqlite({ NODE_NO_WARNINGS: '1' });

function makeWorkspace() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-keep-mut-')));
  fs.mkdirSync(path.join(root, 'atris'), { recursive: true });
  return root;
}

function cleanupWorkspace(root) {
  taskStore.close();
  fs.rmSync(root, { recursive: true, force: true });
}

test('keepTaskList falls back to created_at when updated_at is zero', () => {
  if (!hasNodeSqlite()) return;
  const root = makeWorkspace();
  const now = Date.UTC(2026, 5, 1, 12, 0, 0);
  try {
    const db = taskStore.open(path.join(root, 'tasks.db'));
    const fresh = taskStore.addTask(db, {
      title: 'Fresh task with zero updated_at',
      workspaceRoot: root,
    }).id;
    db.prepare('UPDATE tasks SET created_at = ?, updated_at = 0 WHERE id = ?').run(now, fresh);

    const result = keepTaskList(db, {
      workspaceRoot: root,
      actor: 'tester',
      now,
      missions: [],
    });

    assert.equal(result.put_away.length, 0);
    assert.equal(taskStore.getTask(db, fresh).status, 'open');
  } finally {
    cleanupWorkspace(root);
  }
});

test('keepTaskList uses updated_at when it is newer than created_at', () => {
  if (!hasNodeSqlite()) return;
  const root = makeWorkspace();
  const now = Date.UTC(2026, 5, 1, 12, 0, 0);
  try {
    const db = taskStore.open(path.join(root, 'tasks.db'));
    const blocker = taskStore.addTask(db, {
      title: 'Blocker touched recently but created long ago',
      workspaceRoot: root,
      tag: 'mission-blocker',
      metadata: { mission_id: 'mission-active-1', mission_blocker_class: 'runner-failed' },
    }).id;

    db.prepare('UPDATE tasks SET created_at = ?, updated_at = ? WHERE id = ?').run(
      now - (20 * DAY_MS),
      now - (1 * DAY_MS),
      blocker,
    );

    const result = keepTaskList(db, {
      workspaceRoot: root,
      actor: 'tester',
      now,
      missions: [{ id: 'mission-active-1', status: 'active' }],
    });

    assert.equal(result.put_away.length, 0);
    assert.equal(taskStore.getTask(db, blocker).status, 'open');
  } finally {
    cleanupWorkspace(root);
  }
});
