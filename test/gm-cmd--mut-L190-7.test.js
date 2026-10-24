'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { gmCommand } = require('../commands/gm');

test('manager lists the metadata owner as a player for an unclaimed task', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-owner-'));
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
    fs.mkdirSync(path.join(root, 'atris'), { recursive: true });
    const tasks = require('../lib/task-db');
    const db = tasks.open(process.env.ATRIS_TASKS_DB);
    try {
      db.prepare(`INSERT INTO tasks
        (id, title, status, workspace_root, created_at, updated_at, metadata)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
        'owner-job', 'Prepare release notes', 'open', tasks.workspaceRoot(root),
        1792584000000, 1792584000000, JSON.stringify({ owner: 'ada' })
      );
    } finally {
      tasks.close(db);
    }
    console.log = (...args) => output.push(args.join(' '));
    console.error = (...args) => output.push(args.join(' '));
    process.exit = code => { throw new Error(`unexpected exit ${code}`); };
    await gmCommand('--json', '--no-seed');
    const result = JSON.parse(output.join('\n'));
    assert.strictEqual(result.players[0]?.player, 'ada');
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
