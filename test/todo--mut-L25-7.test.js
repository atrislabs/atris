'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('native claimed owner survives when no legacy claim metadata exists', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-native-owner-'));
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
    taskDb.addTask(db, {
      title: 'Prepare the release notes',
      workspaceRoot: taskDb.workspaceRoot(root),
      status: 'claimed',
      claimedBy: 'builder',
      metadata: {},
    });
    assert.equal(parseTodo(board).inProgress[0]?.claimed, 'builder');
  } finally {
    if (db) taskDb.close(db);
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
