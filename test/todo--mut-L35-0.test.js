'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('parseTodo reports claimed database tasks as in_progress', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-todo-stage-'));
  const previous = {
    ATRIS_TASK_DB: process.env.ATRIS_TASK_DB,
    ATRIS_TASKS_DB: process.env.ATRIS_TASKS_DB,
  };
  let taskDb;
  try {
    process.env.ATRIS_TASK_DB = '1';
    process.env.ATRIS_TASKS_DB = path.join(root, 'tasks.db');
    fs.mkdirSync(path.join(root, 'atris'));
    const todoPath = path.join(root, 'atris', 'TODO.md');
    fs.writeFileSync(todoPath, '# TODO\n\n## Backlog\n\n## In Progress\n\n## Completed\n');

    taskDb = require('../lib/task-db');
    taskDb.close();
    const db = taskDb.open();
    const workspaceRoot = taskDb.workspaceRoot(root);
    const claimed = taskDb.addTask(db, {
      title: 'claimed task with a previous stage',
      workspaceRoot,
      status: 'claimed',
      claimedBy: 'tester',
      metadata: { stage: 'review' },
    });

    const todo = require('../lib/todo');
    const buckets = todo.parseTodo(todoPath);
    assert.deepEqual(
      buckets.inProgress.map(row => ({ id: row.id, stage: row.stage })),
      [{ id: claimed.id, stage: 'in_progress' }],
    );
  } finally {
    if (taskDb) taskDb.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
