'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sqlite = require('node:sqlite');

test('pruning supports the all-only statement API of early Node SQLite', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prune-all-only-'));
  const previousHome = process.env.HOME;
  const OriginalDatabase = sqlite.DatabaseSync;
  process.env.HOME = dir;
  const dbPath = path.join(dir, 'tasks.db');
  const store = require('../lib/task-db');
  const now = 1700000000000;
  try {
    const db = store.open(dbPath);
    db.prepare(`INSERT INTO tasks (id, title, status, workspace_root, created_at, updated_at)
      VALUES (?, ?, 'open', ?, ?, ?)`).run(
      'JUNK', 'discarded test task', path.join(dir, 'gone-a1B2c3'), now - 172800000, now - 172800000);
    store.close();

    // Older supported Node versions provide all(), but no iterator method.
    sqlite.DatabaseSync = class extends OriginalDatabase {
      prepare(sql) {
        const statement = super.prepare(sql);
        return {
          all: statement.all.bind(statement),
          get: statement.get.bind(statement),
          run: statement.run.bind(statement),
        };
      }
    };
    const prune = require('../lib/task-prune');
    const plan = prune.dryRun(dbPath, { now });
    assert.equal(plan.remove.tasks, 1);
  } finally {
    store.close();
    sqlite.DatabaseSync = OriginalDatabase;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
