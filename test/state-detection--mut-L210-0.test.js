'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { getTaskGlance } = require('../lib/state-detection');
const taskDb = require('../lib/task-db');

test('certified review metadata includes the pending task in the title preview', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-certified-glance-'));
  const previousHome = process.env.HOME;
  const previousDb = process.env.ATRIS_TASKS_DB;
  process.env.HOME = root;
  process.env.ATRIS_TASKS_DB = path.join(root, 'tasks.db');
  taskDb.close();
  try {
    const atrisDir = path.join(root, 'atris');
    fs.mkdirSync(atrisDir);
    const db = taskDb.open();
    taskDb.addTask(db, {
      title: 'Publish the checked export',
      status: 'review',
      workspaceRoot: taskDb.workspaceRoot(root),
      metadata: { agent_certified: true, approval_status: 'pending' },
    });

    const glance = getTaskGlance(atrisDir);
    assert.equal(glance.certifiedTitles[0], 'Publish the checked export');
  } finally {
    taskDb.close();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousDb === undefined) delete process.env.ATRIS_TASKS_DB;
    else process.env.ATRIS_TASKS_DB = previousDb;
  }
});
