'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('database opt-in includes saved tasks absent from a plain markdown board', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-opt-in-'));
  const previous = {};
  for (const [key, value] of Object.entries({
    HOME: root,
    ATRIS_TASK_DB: '1',
    ATRIS_TASKS_DB: path.join(root, 'tasks.db'),
  })) {
    previous[key] = process.env[key];
    process.env[key] = value;
  }
  const taskDb = require('../lib/task-db');
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
  fs.writeFileSync(board, '# Tasks\n\n## Backlog\n\n## In Progress\n\n## Completed\n');
  const db = taskDb.open();
  taskDb.addTask(db, { title: 'Saved task awaiting implementation', workspaceRoot: taskDb.workspaceRoot(root) });
  const { parseTodo } = require('../lib/todo');
  assert.equal(parseTodo(board).backlog.some(row => row.title === 'Saved task awaiting implementation'), true);
});
