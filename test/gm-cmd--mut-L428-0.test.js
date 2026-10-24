'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { gmCommand } = require('../commands/gm');

test('an explicit player gets the starter mission when several players are available', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-no-seed-'));
  const savedEnv = { ...process.env };
  const cwd = process.cwd();
  const log = console.log;
  const error = console.error;
  const exit = process.exit;
  const exitCode = process.exitCode;
  const output = [];
  try {
    for (const key of Object.keys(process.env)) delete process.env[key];
    process.env.HOME = root;
    process.env.USER = 'owner';
    process.env.ATRIS_TASKS_DB = path.join(root, 'tasks.db');
    process.chdir(root);
    console.log = (...args) => output.push(args.join(' '));
    console.error = (...args) => output.push(args.join(' '));
    process.exit = code => { throw new Error(`unexpected exit ${code}`); };
    const player = path.join(root, 'atris', 'team', 'ada');
    fs.mkdirSync(player, { recursive: true });
    fs.writeFileSync(path.join(player, 'START_HERE.md'), '# Ada\n');

    const other = path.join(root, 'atris', 'team', 'ben');
    fs.mkdirSync(other, { recursive: true });
    fs.writeFileSync(path.join(other, 'START_HERE.md'), '# Ben\n');

    await gmCommand('--player', 'ada', '--json');
    const result = JSON.parse(output.join('\n'));
    assert.strictEqual(result.missions.length, 1);
    assert.strictEqual(result.missions[0].assigned_to, 'ada');
  } finally {
    console.log = log;
    console.error = error;
    process.exit = exit;
    process.exitCode = exitCode;
    process.chdir(cwd);
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  }
});
