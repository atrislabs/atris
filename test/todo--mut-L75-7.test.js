'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('merging saved tasks preserves an unrelated markdown backlog task', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-merge-title-'));
  const previous = { HOME: process.env.HOME, ATRIS_TASKS_DB: process.env.ATRIS_TASKS_DB, ATRIS_TASK_DB: process.env.ATRIS_TASK_DB };
  process.env.HOME = root;
  process.env.ATRIS_TASKS_DB = path.join(root, 'tasks.db');
  process.env.ATRIS_TASK_DB = '1';
  const taskDb = require('../lib/task-db');
  const { parseTodo } = require('../lib/todo');
  taskDb.close();
  try {
    fs.mkdirSync(path.join(root, 'atris'));
    const board = path.join(root, 'atris', 'TODO.md');
    fs.writeFileSync(board, '# Tasks\n\n## Backlog\n- [ ] Repair export\n');
    const db = taskDb.open();
    taskDb.addTask(db, { title: 'Write documentation', workspaceRoot: taskDb.workspaceRoot(root) });
    const result = parseTodo(board);
    assert.equal(result.backlog.some(row => row.title === 'Repair export' && row._source === 'md'), true);
  } finally {
    taskDb.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
