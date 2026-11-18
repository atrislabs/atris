'use strict';

// The start-up screen judges stuck work from these times, so the summary
// must read old rows stored in seconds and count a fresh note as movement.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { getTaskGlance } = require('../lib/state-detection');
const taskDb = require('../lib/task-db');

test('job times stored in seconds read as the same moment, and a decision tag marks a person wait', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-glance-items-'));
  const previous = process.env.ATRIS_TASKS_DB;
  try {
    process.env.ATRIS_TASKS_DB = path.join(root, 'tasks.db');
    const atrisDir = path.join(root, 'atris');
    fs.mkdirSync(atrisDir);
    const db = taskDb.open();
    const ws = taskDb.workspaceRoot(root);
    const fresh = taskDb.addTask(db, { title: 'fresh job in seconds', workspaceRoot: ws, status: 'claimed', claimedBy: 'test' });
    taskDb.addTask(db, { title: 'held job', tag: 'needs-human', workspaceRoot: ws, status: 'claimed', claimedBy: 'test' });
    const nowSec = Math.floor(Date.now() / 1000);
    const freshId = fresh.id || fresh;
    db.prepare('UPDATE tasks SET claimed_at = ?, created_at = ?, updated_at = ? WHERE id = ?').run(nowSec - 60, nowSec - 60, nowSec - 60, freshId);

    const glance = getTaskGlance(atrisDir);
    const byTitle = Object.fromEntries(glance.activeItems.map((item) => [item.title, item]));
    const item = byTitle['fresh job in seconds'];
    assert.ok(Math.abs(item.startedMs - (nowSec - 60) * 1000) < 2000, `started ${item.startedMs}`);
    assert.ok(Date.now() - item.movedMs < 10 * 60 * 1000, 'a job touched a minute ago is not weeks old');
    assert.equal(item.heldForPerson, false);
    assert.equal(byTitle['held job'].heldForPerson, true, 'needs-human holds the job for a person');
  } finally {
    taskDb.close();
    if (previous === undefined) delete process.env.ATRIS_TASKS_DB;
    else process.env.ATRIS_TASKS_DB = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
