'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('failed task creation shows the database error to the operator', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-error-output-'));
  const previousEnv = { ...process.env };
  const previousCwd = process.cwd();
  const previousError = console.error;
  const previousLog = console.log;
  const previousExit = process.exit;
  const errors = [];
  try {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('ATRIS_')) delete process.env[key];
    }
    process.env.HOME = root;
    process.env.ATRIS_TEST_STATE_DIR = path.join(root, 'home-state');
    const blocker = path.join(root, 'blocked-database-parent');
    fs.writeFileSync(blocker, 'occupied');
    process.env.ATRIS_TASKS_DB = path.join(blocker, 'tasks.db');
    process.chdir(root);
    const state = path.join(root, '.atris', 'state');
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(path.join(state, 'missions.jsonl'), JSON.stringify({
      id: 'seed', status: 'active', objective: 'Improve the next task',
    }) + '\n');
    console.error = (...args) => errors.push(args.join(' '));
    console.log = () => {};
    process.exit = (code) => { throw new Error(`unexpected exit ${code}`); };
    const { createNextLoopTask } = require('../commands/loop-front');
    createNextLoopTask(['--as', 'tester'], root);
    assert.match(errors.join('\n'), /database/);
  } finally {
    console.error = previousError;
    console.log = previousLog;
    process.exit = previousExit;
    process.chdir(previousCwd);
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, previousEnv);
  }
});
