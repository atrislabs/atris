'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ensureStarterMission } = require('../commands/gm');
const taskDb = require('../lib/task-db');

test('the sole task owner receives the starter mission ahead of the sole team member', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-starter-owner-'));
  const env = { ...process.env };
  const cwd = process.cwd();
  let db;
  try {
    for (const key of Object.keys(process.env)) delete process.env[key];
    process.env.HOME = root;
    process.chdir(root);
    const memberDir = path.join(root, 'atris', 'team', 'backup');
    fs.mkdirSync(memberDir, { recursive: true });
    fs.writeFileSync(path.join(memberDir, 'MEMBER.md'), '# Backup\n');
    const workspace = fs.realpathSync(root);
    db = taskDb.open(path.join(root, 'tasks.db'));
    db.prepare(`INSERT INTO tasks
      (id, title, status, workspace_root, created_at, updated_at, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      'existing-task', 'Harvest fruit', 'open', workspace,
      1790000000000, 1790000000000, JSON.stringify({ assigned_to: 'orchard' })
    );
    const tasks = taskDb.listTasks(db, { workspaceRoot: workspace });
    const result = ensureStarterMission(taskDb, db, workspace, tasks, []);
    assert.equal(result.seeded.metadata.assigned_to, 'orchard');
  } finally {
    if (db) taskDb.close(db);
    process.chdir(cwd);
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, env);
  }
});
