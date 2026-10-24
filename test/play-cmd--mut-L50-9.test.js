'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { playCommand } = require('../commands/play');
const taskDb = require('../lib/task-db');

test('options do not replace a positional player', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-option-player-'));
  const savedEnv = { ...process.env };
  const cwd = process.cwd();
  const log = console.log;
  const exit = process.exit;
  const lines = [];
  try {
    for (const key of Object.keys(process.env)) delete process.env[key];
    process.env.HOME = root;
    process.env.ATRIS_TASKS_DB = path.join(root, 'tasks.db');
    fs.mkdirSync(path.join(root, '.git'));
    process.chdir(root);
    console.log = (...parts) => lines.push(parts.join(' '));
    process.exit = (code) => { throw new Error(`unexpected exit ${code}`); };
    await playCommand('--no-seed', '--workspace', root, 'ada', '--json');
    assert.strictEqual(JSON.parse(lines.join('\n')).player, 'ada');
  } finally {
    taskDb.close();
    console.log = log;
    process.exit = exit;
    process.chdir(cwd);
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  }
});
