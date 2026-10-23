'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { keepTaskList } = require('../lib/task-list-keeper');
const taskStore = require('../lib/task-db');

test('explicit cleanup actor is recorded instead of the environment agent', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-actor-priority-'));
  const saved = { HOME: process.env.HOME, ATRIS_AGENT_ID: process.env.ATRIS_AGENT_ID, USER: process.env.USER };
  process.env.HOME = root;
  process.env.ATRIS_AGENT_ID = 'background-agent';
  process.env.USER = 'local-user';
  try {
    const db = taskStore.open(path.join(root, 'tasks.db'));
    const { id } = taskStore.addTask(db, {
      title: 'Finished documentation cleanup',
      workspaceRoot: root,
      status: 'done',
    });
    db.prepare('UPDATE tasks SET created_at = ?, updated_at = ? WHERE id = ?')
      .run(Date.UTC(2026, 0, 1), Date.UTC(2026, 0, 1), id);
    keepTaskList(db, {
      workspaceRoot: root,
      actor: 'cleanup-owner',
      now: Date.UTC(2026, 0, 3),
      missions: [],
    });
    const event = db.prepare('SELECT actor FROM task_events WHERE task_id = ? ORDER BY version DESC LIMIT 1').get(id);
    assert.equal(event.actor, 'cleanup-owner');
  } finally {
    taskStore.close();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
