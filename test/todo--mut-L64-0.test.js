'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('a done database task appears in completed when markdown has no tasks', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-completed-'));
  const previous = {};
  for (const key of ['HOME', 'ATRIS_TASKS_DB', 'ATRIS_TASK_DB']) previous[key] = process.env[key];
  process.env.HOME = root;
  process.env.ATRIS_TASKS_DB = path.join(root, 'tasks.db');
  process.env.ATRIS_TASK_DB = '1';
  const taskDb = require('../lib/task-db');
  const { parseTodo } = require('../lib/todo');
  try {
    fs.mkdirSync(path.join(root, 'atris'));
    const board = path.join(root, 'atris', 'TODO.md');
    fs.writeFileSync(board, '# TODO\n\n## Completed\n');
    const db = taskDb.open();
    const task = taskDb.addTask(db, {
      title: 'Publish the finished guide',
      status: 'done',
      workspaceRoot: taskDb.workspaceRoot(root),
    });
    const result = parseTodo(board);
    assert.equal(result.completed.some(row => row.id === task.id), true);
  } finally {
    taskDb.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
