'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const taskDb = require('../lib/task-db');
const { detectWorkspaceState } = require('../lib/state-detection');

function setEnv(t, key, value) {
  const previous = process.env[key];
  process.env[key] = value;
  t.after(() => {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  });
}

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-blocked-state-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'atris'));
  fs.writeFileSync(path.join(root, 'atris/atris.md'), '');
  return root;
}

function withDb(t, root) {
  const dbPath = path.join(root, 'tasks.db');
  setEnv(t, 'ATRIS_TASKS_DB', dbPath);
  const db = taskDb.open(dbPath);
  t.after(() => taskDb.close());
  return db;
}

test('a backlog task that talks about blocking does not mark the workspace blocked', t => {
  const root = workspace(t);
  const db = withDb(t, root);
  const ws = taskDb.workspaceRoot(root);
  taskDb.addTask(db, { title: 'unblock payments', workspaceRoot: ws });
  taskDb.addTask(db, { title: 'retry the webhook when it is blocked', workspaceRoot: ws });
  const rows = taskDb.listTasks(db, { workspaceRoot: ws });
  fs.writeFileSync(path.join(root, 'atris/TODO.md'), taskDb.renderTodoMarkdown(rows));

  assert.equal(detectWorkspaceState(root).state, 'ready');
});

test('a failed task in the database marks the workspace blocked', t => {
  const root = workspace(t);
  const db = withDb(t, root);
  const ws = taskDb.workspaceRoot(root);
  const task = taskDb.addTask(db, { title: 'ship the invoice export', workspaceRoot: ws });
  taskDb.doneTask(db, { id: task.id, status: 'failed', actor: 'test' });

  assert.equal(detectWorkspaceState(root).state, 'blocked');
});

test('without a database only the Blocked section of TODO.md counts', t => {
  const root = workspace(t);
  setEnv(t, 'ATRIS_TASKS_DB', path.join(root, 'missing.db'));
  const todo = path.join(root, 'atris/TODO.md');

  fs.writeFileSync(todo, [
    '# TODO.md', '',
    '## Backlog', '',
    '- **T1:** unblock payments',
    '- **T2:** payments are blocked by the stripe webhook', '',
    '## Blocked', '',
    '(Empty)', '',
  ].join('\n'));
  assert.equal(detectWorkspaceState(root).state, 'ready');

  fs.writeFileSync(todo, [
    '# TODO.md', '',
    '## Backlog', '',
    '(Empty)', '',
    '## Blocked', '',
    '- **T3:** waiting on the bank login', '',
  ].join('\n'));
  assert.equal(detectWorkspaceState(root).state, 'blocked');
  assert.equal(fs.existsSync(path.join(root, 'missing.db')), false);
});
