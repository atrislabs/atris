'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('certified review awaiting human approval counts as certified', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-certified-review-'));
  const previousHome = process.env.HOME;
  const previousDb = process.env.ATRIS_TASKS_DB;
  process.env.HOME = root;
  process.env.ATRIS_TASKS_DB = path.join(root, 'tasks.db');
  const taskDb = require('../lib/task-db');
  const { getTaskGlance } = require('../lib/state-detection');
  t.after(() => {
    taskDb.close();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousDb === undefined) delete process.env.ATRIS_TASKS_DB;
    else process.env.ATRIS_TASKS_DB = previousDb;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const atrisDir = path.join(root, 'atris');
  fs.mkdirSync(atrisDir);
  const db = taskDb.open(process.env.ATRIS_TASKS_DB);
  taskDb.addTask(db, {
    title: 'Publish the checked guide',
    workspaceRoot: taskDb.workspaceRoot(root),
    status: 'review',
    metadata: { agent_certified: true, approval_status: 'pending' },
  });

  assert.equal(getTaskGlance(atrisDir).reviewCertified, 1);
});
