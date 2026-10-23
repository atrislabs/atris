const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('claimed database task appears in progress without a markdown entry', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-claimed-bucket-'));
  const previous = { HOME: process.env.HOME, ATRIS_TASKS_DB: process.env.ATRIS_TASKS_DB, ATRIS_TASK_DB: process.env.ATRIS_TASK_DB };
  process.env.HOME = root;
  process.env.ATRIS_TASK_DB = '1';
  process.env.ATRIS_TASKS_DB = path.join(root, 'tasks.db');
  const taskDb = require('../lib/task-db');
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
  fs.writeFileSync(path.join(root, 'atris', 'TODO.md'), '# Tasks\n');
  const db = taskDb.open();
  taskDb.addTask(db, {
    title: 'Implement the claimed change',
    workspaceRoot: taskDb.workspaceRoot(root),
    status: 'claimed',
    claimedBy: 'builder',
  });
  const { parseTodo } = require('../lib/todo');
  const result = parseTodo(path.join(root, 'atris', 'TODO.md'));
  assert.equal(result.inProgress.some(row => row.title === 'Implement the claimed change'), true);
});
