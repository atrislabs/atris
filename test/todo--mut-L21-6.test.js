'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const taskDb = require('../lib/task-db');

test('legacy database task with null metadata remains in the backlog', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-null-metadata-'));
  const previous = { HOME: process.env.HOME, ATRIS_TASKS_DB: process.env.ATRIS_TASKS_DB, ATRIS_TASK_DB: process.env.ATRIS_TASK_DB };
  process.env.HOME = root;
  process.env.ATRIS_TASK_DB = '1';
  const { parseTodo } = require('../lib/todo');
  process.env.ATRIS_TASKS_DB = path.join(root, 'tasks.db');
  taskDb.close();
  t.after(() => {
    taskDb.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  fs.mkdirSync(path.join(root, 'atris'));
  fs.writeFileSync(path.join(root, 'atris', 'atris.md'), '');
  const board = path.join(root, 'atris', 'TODO.md');
  fs.writeFileSync(board, '# TODO\n\n## Backlog\n\n## In Progress\n\n## Completed\n');
  const db = taskDb.open();
  // Older rows may omit the nullable metadata column.
  db.prepare(`INSERT INTO tasks
    (id, title, status, workspace_root, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .run('legacy-task', 'Recover the saved task', 'open', taskDb.workspaceRoot(root),
      1704067200000, 1704067200000);

  const result = parseTodo(board);
  assert.equal(result.backlog.find(row => row.title === 'Recover the saved task')?.id, 'legacy-task');
});
