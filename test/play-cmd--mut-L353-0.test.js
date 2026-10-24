'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { playCommand } = require('../commands/play');
const taskDb = require('../lib/task-db');

test('a claimed mission offers submitting proof as its next step', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-claimed-next-'));
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
    taskDb.addTask(taskDb.open(), {
      title: 'Document the release procedure',
      workspaceRoot: fs.realpathSync(root),
      status: 'claimed',
      claimedBy: 'ada',
      metadata: { assigned_to: 'ada' },
    });
    console.log = (...parts) => lines.push(parts.join(' '));
    process.exit = code => { throw new Error(`unexpected exit ${code}`); };
    await playCommand('--as', 'ada', '--workspace', root, '--no-seed', '--json');
    const state = JSON.parse(lines.join('\n'));
    assert.match(state.next_commands[0], /^atris task ready\b/);
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
