'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tasks = require('../lib/task-db');

for (const kind of ['tag', 'chat', 'plan', 'reopen', 'backlog']) {
  test(`${kind} rolls back the row when its event fails`, () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'task-event-atomic-'));
    const db = tasks.open(path.join(tmp, 'tasks.db'));
    try {
      const { id } = tasks.addTask(db, { title: 'test task', workspaceRoot: tmp, metadata: { stage: 'plan', task_goal: 'goal', verify: 'node --test', exit_condition: 'done' } });
      if (kind === 'reopen') db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(id);
      const before = tasks.getTask(db, id);
      const eventType = { tag: 'task_tags_updated', chat: 'task_chat', plan: 'task_planned', reopen: 'reopened', backlog: 'task_backlogged' }[kind];
      db.exec(`CREATE TRIGGER fail_event BEFORE INSERT ON task_events WHEN NEW.event_type = '${eventType}' BEGIN SELECT RAISE(ABORT, 'test failure'); END`);
      assert.throws(() => {
        if (kind === 'tag') tasks.tagTask(db, { id, actor: 'test', add: ['priority'] });
        else if (kind === 'chat') tasks.chatTask(db, { id, actor: 'test', goal: 'new goal' });
        else if (kind === 'plan') tasks.stageTask(db, { id, actor: 'test', stage: 'plan', goal: 'new goal', exit: 'done', proofNeeded: 'node --test' });
        else if (kind === 'reopen') tasks.reopenTask(db, { id, actor: 'test' });
        else tasks.backlogTask(db, { id, actor: 'test' });
      }, /test failure/);
      assert.deepEqual(tasks.getTask(db, id), before);
    } finally {
      tasks.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
}
