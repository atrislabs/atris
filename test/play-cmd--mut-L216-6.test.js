'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { playCommand } = require('../commands/play');
const taskDb = require('../lib/task-db');

test('the player own claim takes priority over another claim assigned to them', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-player-claim-')));
  const savedHome = process.env.HOME;
  const savedDb = process.env.ATRIS_TASKS_DB;
  process.env.ATRIS_TASKS_DB = path.join(root, 'tasks.db');
  fs.mkdirSync(path.join(root, '.git'));
  process.env.HOME = root;
  try {
    const db = taskDb.open(path.join(root, 'tasks.db'));
    const own = taskDb.addTask(db, {
      title: 'Check the release',
      workspaceRoot: root,
      status: 'claimed',
      claimedBy: 'alice',
      metadata: { assigned_to: 'alice' },
    });
    const other = taskDb.addTask(db, {
      title: 'Prepare the release notes',
      workspaceRoot: root,
      status: 'claimed',
      claimedBy: 'bob',
      metadata: { assigned_to: 'alice' },
    });
    db.prepare('UPDATE tasks SET created_at = ? WHERE id = ?').run(1000, own.id);
    db.prepare('UPDATE tasks SET created_at = ? WHERE id = ?').run(2000, other.id);
    const lines = [];
    const originalLog = console.log;
    try {
      console.log = (...parts) => lines.push(parts.join(' '));
      await playCommand('--as', 'alice', '--workspace', root, '--no-seed', '--json');
    } finally {
      console.log = originalLog;
    }
    assert.equal(JSON.parse(lines.join('\n')).mission.id, own.id);
  } finally {
    taskDb.close();
    if (savedDb === undefined) delete process.env.ATRIS_TASKS_DB;
    else process.env.ATRIS_TASKS_DB = savedDb;
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  }
});
