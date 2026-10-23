'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('successful git identity selects the matching team member without a player flag', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'play-git-member-'));
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
    process.env.GIT_CONFIG_GLOBAL = path.join(root, 'identity');
    process.env.GIT_CONFIG_NOSYSTEM = '1';
    fs.writeFileSync(process.env.GIT_CONFIG_GLOBAL,
      '[user]\n email = river@river.dev\n name = River Stone\n');
    const member = path.join(root, 'atris', 'team', 'river');
    fs.mkdirSync(member, { recursive: true });
    fs.writeFileSync(path.join(member, 'MEMBER.md'), '# River\n\nEmail: river@river.dev\n');
    process.chdir(root);
    console.log = (...parts) => lines.push(parts.join(' '));
    process.exit = code => { throw new Error(`unexpected exit: ${code}`); };

    const { playCommand } = require('../commands/play');
    taskDb = require('../lib/task-db');
    await playCommand('--no-seed', '--workspace', root, '--json');
    const state = JSON.parse(lines.join('\n'));
    assert.equal(state.player, 'river', 'git email should identify the workspace team member');
    assert.equal(state.player_source, 'git_team_match');
  } finally {
    if (taskDb) taskDb.close();
    console.log = savedLog;
    process.exit = savedExit;
    process.chdir(savedCwd);
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  }
});
