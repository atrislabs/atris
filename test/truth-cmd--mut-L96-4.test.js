'use strict';
require('./helpers/clean-temp');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { truthCommand } = require('../commands/truth');

test('task report falls back to shared review counts when local rows are absent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-empty-task-counts-'));
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
    const child = path.join(dir, 'child');
    execFileSync('git', ['init', '--quiet', dir]);
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '--allow-empty', '-m', 'fixture'], { cwd: dir, env: { ...process.env, GIT_AUTHOR_DATE: '2024-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2024-01-01T00:00:00Z' } });
    execFileSync('git', ['worktree', 'add', '--quiet', '--detach', child], { cwd: dir });
    fs.mkdirSync(path.join(child, 'atris'));
    process.chdir(child);
    fs.mkdirSync(path.join(dir, 'atris'));
    store = require('../lib/task-db');
    const db = store.open();
    db.prepare(`INSERT INTO tasks (id, title, status, workspace_root, created_at, updated_at, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run('01J00000000000000000000000', 'Review shared work', 'review',
        fs.realpathSync(dir), 1704067200000, 1704067200000, '{}');
    console.log = (...args) => output.push(args.join(' '));
    process.exit = code => { throw new Error(`unexpected exit ${code}`); };
    truthCommand(['--json']);
    assert.strictEqual(JSON.parse(output.join('\n')).tasks.review, 1);
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
