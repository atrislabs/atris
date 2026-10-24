'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { playCommand } = require('../commands/play');
const taskDb = require('../lib/task-db');

test('a mission claimed without an assignment shows its claimant as assignee', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-claim-owner-'));
  const savedEnv = { ...process.env };
  const savedCwd = process.cwd();
  const savedLog = console.log;
  const savedExit = process.exit;
  const lines = [];
  try {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('ATRIS_')) delete process.env[key];
    }
    process.env.HOME = root;
    process.env.ATRIS_TASKS_DB = path.join(root, 'tasks.db');
    process.chdir(root);
    fs.mkdirSync(path.join(root, '.git'));
    const db = taskDb.open();
    const task = taskDb.addTask(db, {
      title: 'Document the release procedure',
      workspaceRoot: fs.realpathSync(root),
    });
    taskDb.claimTask(db, { id: task.id, claimedBy: 'ada' });
    console.log = (...parts) => lines.push(parts.join(' '));
    process.exit = code => { throw new Error(`unexpected exit ${code}`); };
    await playCommand('--as', 'ada', '--workspace', root, '--no-seed', '--json');
    const state = JSON.parse(lines.join('\n'));
    assert.equal(state.mission.assigned_to, 'ada');
  } finally {
    console.log = savedLog;
    process.exit = savedExit;
    taskDb.close();
    process.chdir(savedCwd);
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key];
    }
    Object.assign(process.env, savedEnv);
  }
});
