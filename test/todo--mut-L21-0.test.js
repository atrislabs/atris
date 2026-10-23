'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const taskDb = require('../lib/task-db');

test('saved task stage survives parsing', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-todo-assignment-'));
  const previous = { HOME: process.env.HOME, ATRIS_TASKS_DB: process.env.ATRIS_TASKS_DB, ATRIS_TASK_DB: process.env.ATRIS_TASK_DB };
  process.env.HOME = root;
  process.env.ATRIS_TASKS_DB = path.join(root, 'tasks.db');
  process.env.ATRIS_TASK_DB = '1';
  const todo = require('../lib/todo');
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
  const db = taskDb.open();
  taskDb.addTask(db, {
    title: 'Prepare the release notes',
    workspaceRoot: taskDb.workspaceRoot(root),
    metadata: { stage: 'review' },
  });
  fs.writeFileSync(path.join(root, 'atris', 'TODO.md'), '# TODO\n\n## Backlog\n');
  const parsed = todo.parseTodo(path.join(root, 'atris', 'TODO.md'));
  assert.equal(parsed.backlog[0].stage, 'review');
});
