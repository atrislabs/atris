'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createStarterTask, starterTaskTitle } = require('../lib/context-gatherer');

test('createStarterTask reports the claimed starter display ref, not an older open row', (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'context-gatherer-mut-'));
  const savedEnv = {
    ATRIS_TASKS_DB: process.env.ATRIS_TASKS_DB,
    ATRIS_OPERATOR: process.env.ATRIS_OPERATOR,
    HOME: process.env.HOME,
    LOGNAME: process.env.LOGNAME,
    USER: process.env.USER,
  };
  const taskDb = require('../lib/task-db');
  t.after(() => {
    taskDb.close();
    for (const key of Object.keys(savedEnv)) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    fs.rmSync(temporary, { recursive: true, force: true });
  });

  process.env.HOME = temporary;
  process.env.USER = 'alex';
  process.env.LOGNAME = 'alex';
  delete process.env.ATRIS_OPERATOR;
  process.env.ATRIS_TASKS_DB = path.join(temporary, 'tasks.db');

  const root = path.join(temporary, 'garden');
  fs.mkdirSync(path.join(root, 'atris'), { recursive: true });
  const answer = 'build a garden website';
  const title = starterTaskTitle(answer);
  const db = taskDb.open();
  const workspaceRoot = taskDb.workspaceRoot(root);
  taskDb.addTask(db, {
    title: 'older open neighbor',
    tag: 'endgame',
    workspaceRoot,
    status: 'open',
  });
  const seeded = taskDb.addTask(db, {
    title,
    tag: 'onboarding',
    workspaceRoot,
    sourceKey: taskDb.sourceKey('context-gatherer:first-task', title),
    status: 'open',
  });

  const result = createStarterTask(root, answer);
  const refreshed = taskDb.withTaskDisplayRefs(
    taskDb.listTasks(db, { workspaceRoot }),
  ).find((row) => row.id === seeded.id);

  assert.deepStrictEqual(result, {
    id: seeded.id,
    inserted: false,
    display_id: refreshed.display_id,
    title,
    status: 'claimed',
    claimed_by: refreshed.claimed_by,
  });
});
