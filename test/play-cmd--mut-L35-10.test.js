'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { playCommand } = require('../commands/play');
const taskDb = require('../lib/task-db');

test('inline player option preserves the supplied handle', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-inline-player-'));
  const savedEnv = { ...process.env };
  const cwd = process.cwd();
  const log = console.log;
  const exit = process.exit;
  const lines = [];
  try {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('ATRIS_')) delete process.env[key];
    }
    process.env.HOME = root;
    process.env.ATRIS_TASKS_DB = path.join(root, 'tasks.db');
    fs.mkdirSync(path.join(root, '.git'));
    process.chdir(root);
    console.log = (...parts) => lines.push(parts.join(' '));
    process.exit = code => { throw new Error(`unexpected exit ${code}`); };
    await playCommand('--as=alice', '--workspace', root, '--no-seed', '--json');
    assert.equal(JSON.parse(lines.join('\n')).player, 'alice');
  } finally {
    console.log = log;
    process.exit = exit;
    taskDb.close();
    process.chdir(cwd);
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key];
    }
    Object.assign(process.env, savedEnv);
  }
});
