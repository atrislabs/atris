'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { truthCommand } = require('../commands/truth');

test('workspace report counts a task awaiting review', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-review-count-'));
  const cwd = process.cwd();
  const keys = ['HOME', 'ATRIS_TASKS_DB', 'ATRIS_TEST_STATE_DIR'];
  const previous = keys.map(key => process.env[key]);
  const log = console.log;
  const exit = process.exit;
  const output = [];
  let store;
  try {
    process.env.HOME = dir;
    process.env.ATRIS_TASKS_DB = path.join(dir, 'tasks.db');
    process.env.ATRIS_TEST_STATE_DIR = dir;
    process.chdir(dir);
    fs.mkdirSync(path.join(dir, 'atris'));
    fs.writeFileSync(path.join(dir, 'atris', 'atris.md'), '# workspace\n');
    store = require('../lib/task-db');
    const db = store.open();
    db.prepare(`INSERT INTO tasks
      (id, title, status, workspace_root, created_at, updated_at, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run('01J00000000000000000000000', 'Check saved report', 'review',
        store.workspaceRoot(dir), 1704067200000, 1704067200000,
        JSON.stringify({ approval_status: 'pending' }));
    console.log = (...args) => output.push(args.join(' '));
    process.exit = code => { throw new Error(`unexpected exit ${code}`); };
    truthCommand(['--json']);
    assert.equal(JSON.parse(output.join('\n')).tasks.review, 1);
  } finally {
    console.log = log;
    process.exit = exit;
    if (store) store.close();
    process.chdir(cwd);
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
  }
});
