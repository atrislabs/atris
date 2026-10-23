'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { applyPrune, tempRoots } = require('../lib/task-prune');

test('pruning preserves a task whose title changed after the backup', (t) => {
  const now = 946684800000;
  t.mock.method(Date, 'now', () => now);
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'prune-changed-task-')));
  const dbPath = path.join(dir, 'tasks.db');
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY, title TEXT, status TEXT, tag TEXT,
        workspace_root TEXT, source_key TEXT, claimed_by TEXT,
        claimed_at INTEGER, created_at INTEGER, updated_at INTEGER,
        done_at INTEGER, metadata TEXT
      );
      CREATE TABLE task_events (
        task_id TEXT, version INTEGER, workspace_root TEXT, created_at INTEGER
      );
    `);
    const root = path.join(dir, 'gone-a1B2c3');
    db.prepare(`INSERT INTO tasks (id, title, status, workspace_root, created_at, updated_at)
      VALUES ('changed', 'original title', 'open', ?, 1, 1)`).run(root);
    db.prepare(`INSERT INTO task_events VALUES ('changed', 1, ?, 1)`).run(root);

    const result = applyPrune(dbPath, {
      now,
      roots: tempRoots({ tmpdir: dir, named: [] }),
      afterBackup() {
        // Keep timestamps and history unchanged so only the row fingerprint differs.
        db.prepare("UPDATE tasks SET title = 'edited title' WHERE id = 'changed'").run();
      },
    });

    assert.deepEqual(result.planned, {
      tasks: 1, history_rows: 1, stray_history_rows: 0, part_uses: 0,
    });
    assert.deepEqual(result.skipped, {
      changed_since_backup: 1, held: 0, recent: 0, folder_exists: 0,
    });
    assert.deepEqual(result.removed, {
      tasks: 0, history_rows: 0, stray_history_rows: 0, part_uses: 0,
    });
    assert.equal(result.total_tasks, 1);
    assert.equal(db.prepare("SELECT title FROM tasks WHERE id = 'changed'").get().title, 'edited title');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM task_events').get().n, 1);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
