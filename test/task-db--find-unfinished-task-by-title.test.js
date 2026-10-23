'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-title-lookup-'));
const savedEnv = Object.fromEntries(Object.entries(process.env)
  .filter(([key]) => key === 'HOME' || key.startsWith('ATRIS_')));
for (const key of Object.keys(process.env)) {
  if (key.startsWith('ATRIS_')) delete process.env[key];
}
process.env.HOME = home;
const taskDb = require('../lib/task-db');

test.after(() => {
  taskDb.close();
  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.HOME;
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('ATRIS_')) delete process.env[key];
  }
  Object.assign(process.env, savedEnv);
});

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(home, 'database-'));
  const db = taskDb.open(path.join(dir, 'tasks.db'));
  t.after(() => taskDb.close());
  const workspaceRoot = path.join(dir, 'workspace');
  const insert = db.prepare(`
    INSERT INTO tasks (id, title, status, workspace_root, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  return {
    db,
    workspaceRoot,
    add(id, title, status = 'open', createdAt = 1700000000000, ws = workspaceRoot) {
      insert.run(id, title, status, ws, createdAt, createdAt);
    },
  };
}

test('matches open and claimed titles ignoring case and repeated whitespace', (t) => {
  const { db, workspaceRoot, add } = fixture(t);
  add('open-task', '  Fix\t the\n Login  ');
  add('claimed-task', 'Ship release', 'claimed');

  assert.deepStrictEqual(
    { ...taskDb.findUnfinishedTaskByTitle(db, { workspaceRoot, title: 'FIX the login' }) },
    { id: 'open-task', title: '  Fix\t the\n Login  ' },
  );
  assert.deepStrictEqual(
    { ...taskDb.findUnfinishedTaskByTitle(db, { workspaceRoot, title: ' ship  RELEASE ' }) },
    { id: 'claimed-task', title: 'Ship release' },
  );
});

test('returns the oldest eligible match and excludes other workspaces and statuses', (t) => {
  const { db, workspaceRoot, add } = fixture(t);
  add('newer', 'Same job', 'open', 1700000005000);
  add('other-workspace', 'Same job', 'open', 1700000000000, path.join(workspaceRoot, 'other'));
  for (const status of ['review', 'done', 'failed', 'archived']) {
    add(status, 'Same job', status, 1700000000000);
  }
  add('oldest', 'SAME JOB', 'claimed', 1700000001000);

  assert.deepStrictEqual(
    { ...taskDb.findUnfinishedTaskByTitle(db, { workspaceRoot, title: 'same job' }) },
    { id: 'oldest', title: 'SAME JOB' },
  );
});

test('returns null for empty titles, missing matches, and ineligible tasks', (t) => {
  const { db, workspaceRoot, add } = fixture(t);
  assert.strictEqual(taskDb.findUnfinishedTaskByTitle(db, { workspaceRoot, title: 'Missing' }), null);
  add('reviewed', 'Already submitted', 'review');
  add('punctuated', 'Fix login!');
  for (const title of ['', ' \t\n ', null, undefined, 'Already submitted', 'Fix login', 'Fix']) {
    assert.strictEqual(taskDb.findUnfinishedTaskByTitle(db, { workspaceRoot, title }), null);
  }
});
