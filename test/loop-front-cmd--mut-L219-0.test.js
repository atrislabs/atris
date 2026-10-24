'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('an existing active task is identified in the creation notice', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'active-task-notice-'));
  const previousEnv = { ...process.env };
  const previousCwd = process.cwd();
  const previousLog = console.log;
  const previousExit = process.exit;
  const lines = [];
  try {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('ATRIS_')) delete process.env[key];
    }
    process.env.HOME = root;
    process.env.ATRIS_TEST_STATE_DIR = path.join(root, 'home-state');
    process.env.ATRIS_TASKS_DB = path.join(root, 'tasks.db');
    process.chdir(root);
    const state = path.join(root, '.atris', 'state');
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(path.join(state, 'tasks.projection.json'), JSON.stringify({
      tasks: [{
        id: 'task-active',
        display_id: 'T731',
        title: 'Repair login validation',
        status: 'claimed',
        claimed_by: 'tester',
        tag: 'loop',
      }],
    }));
    const { createNextLoopTask } = require('../commands/loop-front');
    console.log = (...args) => lines.push(args.join(' '));
    process.exit = (code) => { throw new Error(`unexpected exit: ${code}`); };
    createNextLoopTask([], root);
    assert.ok(lines.some((line) => /active task/.test(line) && line.includes('T731')));
  } finally {
    console.log = previousLog;
    process.exit = previousExit;
    process.chdir(previousCwd);
    for (const key of Object.keys(process.env)) {
      if (!(key in previousEnv)) delete process.env[key];
    }
    Object.assign(process.env, previousEnv);
  }
});
