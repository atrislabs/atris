'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('a git identity outside the team does not replace the local player', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'play-unmatched-git-'));
  const savedEnv = { ...process.env };
  const savedCwd = process.cwd();
  const savedLog = console.log;
  const savedExit = process.exit;
  const lines = [];
  let taskDb;
  try {
    for (const key of Object.keys(process.env)) delete process.env[key];
    process.env.HOME = root;
    process.env.USER = 'sailor';
    process.env.ATRIS_TASKS_DB = path.join(root, 'tasks.db');
    process.env.GIT_CONFIG_GLOBAL = path.join(root, 'identity');
    process.env.GIT_CONFIG_NOSYSTEM = '1';
    fs.writeFileSync(process.env.GIT_CONFIG_GLOBAL,
      '[user]\n email = river@example.org\n name = River Stone\n');
    fs.mkdirSync(path.join(root, '.git'));
    fs.mkdirSync(path.join(root, 'atris', 'team'), { recursive: true });
    process.chdir(root);
    console.log = (...parts) => lines.push(parts.join(' '));
    process.exit = code => { throw new Error(`unexpected exit: ${code}`); };
    const { playCommand } = require('../commands/play');
    taskDb = require('../lib/task-db');
    await playCommand('--no-seed', '--workspace', root, '--json');
    const state = JSON.parse(lines.join('\n'));
    assert.equal(state.player, 'sailor');
  } finally {
    if (taskDb) taskDb.close();
    console.log = savedLog;
    process.exit = savedExit;
    process.chdir(savedCwd);
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  }
});
