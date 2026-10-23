'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('saved done and failed tasks populate completed with an empty Markdown board', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-completed-tasks-'));
  const saved = {};
  for (const key of ['HOME', 'ATRIS_TASKS_DB', 'ATRIS_TASK_DB']) saved[key] = process.env[key];
  process.env.HOME = root;
  process.env.ATRIS_TASKS_DB = path.join(root, 'tasks.db');
  process.env.ATRIS_TASK_DB = '1';
  const taskDb = require('../lib/task-db');
  const { parseTodo } = require('../lib/todo');
  let db;
  try {
    fs.mkdirSync(path.join(root, 'atris'));
    fs.writeFileSync(path.join(root, 'atris', 'atris.md'), '');
    const board = path.join(root, 'atris', 'TODO.md');
    fs.writeFileSync(board, '# Tasks\n\n## Backlog\n\n## In Progress\n\n## Completed\n');
    db = taskDb.open();
    for (const status of ['done', 'failed']) {
      taskDb.addTask(db, {
        title: `Saved ${status} task`,
        workspaceRoot: taskDb.workspaceRoot(root),
        status,
        metadata: {},
      });
    }
    const completed = parseTodo(board).completed;
    assert.equal(completed.some(row => row.title === 'Saved done task'), true);
    assert.equal(completed.some(row => row.title === 'Saved failed task'), true);
  } finally {
    if (db) taskDb.close(db);
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
