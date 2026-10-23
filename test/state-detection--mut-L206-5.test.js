'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { getTaskGlance } = require('../lib/state-detection');
const taskDb = require('../lib/task-db');

test('a zero title sample still counts active database tasks without returning titles', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-glance-limit-'));
  const previous = process.env.ATRIS_TASKS_DB;
  try {
    process.env.ATRIS_TASKS_DB = path.join(root, 'tasks.db');
    const atrisDir = path.join(root, 'atris');
    fs.mkdirSync(atrisDir);
    const db = taskDb.open();
    taskDb.addTask(db, {
      title: 'ship the invoice export',
      workspaceRoot: taskDb.workspaceRoot(root),
      status: 'claimed',
      claimedBy: 'test'
    });

    assert.deepEqual(getTaskGlance(atrisDir, 0), {
      backlog: 0,
      active: 1,
      review: 0,
      reviewCertified: 0,
      activeTitles: [],
      backlogTitles: [],
      certifiedTitles: [],
      source: 'db'
    });
  } finally {
    taskDb.close();
    if (previous === undefined) delete process.env.ATRIS_TASKS_DB;
    else process.env.ATRIS_TASKS_DB = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
