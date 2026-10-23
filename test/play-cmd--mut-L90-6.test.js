'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('task chat updates do not become the mission prompt', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'play-prompt-'));
  const savedEnv = { ...process.env };
  const savedCwd = process.cwd();
  const savedLog = console.log;
  const savedExit = process.exit;
  const lines = [];
  let taskDb;
  try {
    for (const key of Object.keys(process.env)) delete process.env[key];
    process.env.HOME = root;
    process.env.ATRIS_TASKS_DB = path.join(root, 'tasks.db');
    process.chdir(root);
    fs.mkdirSync(path.join(root, 'atris'));
    console.log = (...parts) => lines.push(parts.join(' '));
    process.exit = code => { throw new Error(`unexpected exit: ${code}`); };
    const { playCommand } = require('../commands/play');
    taskDb = require('../lib/task-db');
    const db = taskDb.open();
    const { id } = taskDb.addTask(db, {
      title: 'Document the setup steps',
      workspaceRoot: fs.realpathSync(root),
      metadata: { assigned_to: 'river' },
    });
    taskDb.chatTask(db, {
      id,
      actor: 'river',
      content: 'The setup instructions are ready for review.',
    });
    await playCommand('--as', 'river', '--no-seed', '--workspace', root, '--json');
    const state = JSON.parse(lines.join('\n'));
    assert.equal(state.mission.prompt, null);
  } finally {
    if (taskDb) taskDb.close();
    console.log = savedLog;
    process.exit = savedExit;
    process.chdir(savedCwd);
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  }
});
