'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { gmCommand } = require('../commands/gm');

test('naming the manager opens manager mode even when that member is asleep', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-manager-mode-'));
  const env = { ...process.env };
  const cwd = process.cwd();
  const log = console.log;
  const error = console.error;
  const exit = process.exit;
  const exitCode = process.exitCode;
  const output = [];
  try {
    for (const key of Object.keys(process.env)) delete process.env[key];
    process.env.HOME = root;
    process.env.ATRIS_TASKS_DB = path.join(root, 'tasks.db');
    process.chdir(root);
    const memberDir = path.join(root, 'atris', 'team', 'game-manager');
    fs.mkdirSync(memberDir, { recursive: true });
    fs.writeFileSync(path.join(memberDir, 'MEMBER.md'), '# Game Manager\n');
    const stateDir = path.join(root, '.atris', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'member-switches.json'), JSON.stringify({
      members: { 'game-manager': { awake: false } },
    }));
    console.log = (...args) => output.push(args.join(' '));
    console.error = (...args) => output.push(args.join(' '));
    process.exit = code => { throw new Error(`unexpected exit ${code}`); };
    await gmCommand('game-manager', '--no-seed');
    assert.match(output.join('\n'), /General Manager/);
  } finally {
    console.log = log;
    console.error = error;
    process.exit = exit;
    process.exitCode = exitCode;
    process.chdir(cwd);
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, env);
  }
});
