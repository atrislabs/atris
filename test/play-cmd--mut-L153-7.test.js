'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('saved account name supplies the player when no handle is given', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-saved-player-'));
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
    process.env.TERM_SESSION_ID = 'saved-player-test';
    fs.mkdirSync(path.join(root, '.git'));
    fs.mkdirSync(path.join(root, '.atris'));
    fs.writeFileSync(path.join(root, '.atris', 'credentials.json'), JSON.stringify({
      name: 'Morgan Rivera',
    }));
    process.chdir(root);
    console.log = (...parts) => lines.push(parts.join(' '));
    process.exit = code => { throw new Error(`unexpected exit: ${code}`); };
    const { playCommand } = require('../commands/play');
    taskDb = require('../lib/task-db');
    await playCommand('--no-seed', '--workspace', root, '--json');
    const state = JSON.parse(lines.join('\n'));
    assert.equal(state.player, 'morgan-rivera');
  } finally {
    if (taskDb) taskDb.close();
    console.log = savedLog;
    process.exit = savedExit;
    process.chdir(savedCwd);
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  }
});
