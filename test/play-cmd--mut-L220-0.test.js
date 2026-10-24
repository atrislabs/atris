'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { playCommand } = require('../commands/play');
const taskDb = require('../lib/task-db');

test('an assigned open mission beats assigned work claimed by another player', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'play-priority-'));
  const savedEnv = { ...process.env };
  const savedCwd = process.cwd();
  const savedLog = console.log;
  const savedExit = process.exit;
  try {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('ATRIS_')) delete process.env[key];
    }
    process.env.HOME = root;
    process.env.ATRIS_TASKS_DB = path.join(root, 'tasks.db');
    fs.mkdirSync(path.join(root, '.git'));
    process.chdir(root);
    const db = taskDb.open(process.env.ATRIS_TASKS_DB);
    const available = taskDb.addTask(db, {
      title: 'Available repair', workspaceRoot: fs.realpathSync(root),
      metadata: { assigned_to: 'tester' },
    });
    const claimed = taskDb.addTask(db, {
      title: 'Assigned repair', workspaceRoot: fs.realpathSync(root),
      metadata: { assigned_to: 'tester' }, status: 'claimed', claimedBy: 'other',
    });
    db.prepare('UPDATE tasks SET created_at = ?, updated_at = ? WHERE id = ?').run(1704240000000, 1704240000000, claimed.id);
    db.prepare('UPDATE tasks SET created_at = ?, updated_at = ? WHERE id = ?').run(1704153600000, 1704153600000, available.id);
    const lines = [];
    console.log = (...parts) => lines.push(parts.join(' '));
    process.exit = code => { throw new Error(`unexpected exit ${code}`); };
    await playCommand('--as', 'tester', '--no-seed', '--workspace', root, '--json');
    assert.strictEqual(JSON.parse(lines.join('\n')).mission.id, available.id);
  } finally {
    console.log = savedLog;
    process.exit = savedExit;
    taskDb.close();
    process.chdir(savedCwd);
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  }
});
