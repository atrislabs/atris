'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { truthCommand } = require('../commands/truth');

test('truth preserves the workspace scope when the task database is unreadable', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-truth-corrupt-db-'));
  const previousCwd = process.cwd();
  const previousDb = process.env.ATRIS_TASKS_DB;
  const previousLog = console.log;
  const output = [];
  try {
    fs.mkdirSync(path.join(dir, 'atris'));
    const dbPath = path.join(dir, 'tasks.db');
    fs.writeFileSync(dbPath, 'this is not a sqlite database');
    process.env.ATRIS_TASKS_DB = dbPath;
    process.chdir(dir);
    console.log = (...args) => output.push(args.join(' '));

    assert.equal(truthCommand(['--json']), 0);
    const result = JSON.parse(output.join('\n'));
    assert.equal(result.tasks, null);
    assert.deepEqual(result.scope, {
      kind: 'workspace',
      workspace_root: fs.realpathSync(dir),
    });
  } finally {
    console.log = previousLog;
    process.chdir(previousCwd);
    if (previousDb === undefined) delete process.env.ATRIS_TASKS_DB;
    else process.env.ATRIS_TASKS_DB = previousDb;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
