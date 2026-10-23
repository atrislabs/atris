'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const { truthCommand } = require('../commands/truth');

test('workspace scope resolves to repository root from a subdirectory', () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-mut-')));
  const repo = path.join(tmp, 'repo');
  const sub = path.join(repo, 'sub');
  fs.mkdirSync(path.join(sub, 'atris'), { recursive: true });
  execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore' });

  const dbPath = path.join(tmp, 'tasks.db');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE tasks (id TEXT PRIMARY KEY, status TEXT, workspace_root TEXT)');
  db.prepare('INSERT INTO tasks (id, status, workspace_root) VALUES (?, ?, ?)').run('t1', 'open', tmp);
  db.close();

  const prevCwd = process.cwd();
  const prevHome = process.env.HOME;
  const prevDb = process.env.ATRIS_TASKS_DB;
  const prevLog = console.log;
  const out = [];
  console.log = (...a) => out.push(a.join(' '));

  try {
    process.chdir(sub);
    process.env.HOME = tmp;
    process.env.ATRIS_TASKS_DB = dbPath;
    truthCommand(['--json']);
  } finally {
    console.log = prevLog;
    process.chdir(prevCwd);
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevDb === undefined) delete process.env.ATRIS_TASKS_DB; else process.env.ATRIS_TASKS_DB = prevDb;
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  const result = JSON.parse(out.join('\n'));
  assert.equal(result.scope.workspace_root, repo);
  assert.equal(result.tasks.open, undefined);
});
