'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.ATRIS_TASK_DB = '1';

const mod = require('../lib/todo');

test('unclaimed task preserves metadata stage', (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-stage-'));
  const repo = path.join(base, 'repo');
  fs.mkdirSync(path.join(repo, 'atris'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'atris', 'board.md'), '# Tasks\n\n## Backlog\n\n## In Progress\n\n## Completed\n');

  const prevDb = process.env.ATRIS_TASKS_DB;
  const prevHome = process.env.HOME;

  process.env.ATRIS_TASKS_DB = path.join(base, 'tasks.db');
  process.env.HOME = base;

  const taskDb = require('../lib/task-db');
  taskDb.close();

  t.after(() => {
    taskDb.close();
    if (prevDb === undefined) delete process.env.ATRIS_TASKS_DB;
    else process.env.ATRIS_TASKS_DB = prevDb;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    fs.rmSync(base, { recursive: true, force: true });
  });

  const db = taskDb.open();
  const workspaceRoot = taskDb.workspaceRoot(repo);
  taskDb.addTask(db, {
    title: 'sample task',
    workspaceRoot,
    metadata: { stage: 'planning' },
  });

  const board = mod.parseTodo(path.join(repo, 'atris', 'board.md'));

  assert.strictEqual(board.backlog[0].stage, 'planning');
});
