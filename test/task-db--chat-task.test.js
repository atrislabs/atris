'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// All state fenced to a throwaway home before the module loads.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-chat-task-'));
process.env.HOME = tmpHome;
for (const key of Object.keys(process.env)) {
  if (key.startsWith('ATRIS_')) delete process.env[key];
}
const dbPath = path.join(tmpHome, '.atris', 'tasks.db');
process.env.ATRIS_TASKS_DB = dbPath;

const taskDb = require('../lib/task-db');
const db = taskDb.open(dbPath);
const ws = path.join(tmpHome, 'workspace');

test.after(() => taskDb.close());

test('chatTask records a message on an open task', () => {
  const { id } = taskDb.addTask(db, { title: 'chat me', workspaceRoot: ws });

  const result = taskDb.chatTask(db, {
    id,
    actor: 'tester',
    content: '  hello\n   task  ',
  });

  assert.strictEqual(result.chatted, true);
  assert.strictEqual(result.goal_changed, false);
  assert.strictEqual(result.event.event_type, 'task_chat');
  assert.strictEqual(result.event.actor, 'tester');
  assert.strictEqual(result.event.payload.content, 'hello task');
  assert.strictEqual(result.event.payload.goal, null);
  assert.strictEqual(result.chat_packet, 'TASK_CHAT_UPDATE\nmessage: hello task');

  const events = taskDb.listTaskEvents(db, { taskId: id });
  const chatEvents = events.filter((e) => e.event_type === 'task_chat');
  assert.strictEqual(chatEvents.length, 1);
  assert.strictEqual(chatEvents[0].payload.content, 'hello task');
});

test('chatTask updates goal and summary metadata and flags goal changes', () => {
  const { id } = taskDb.addTask(db, {
    title: 'refine me',
    workspaceRoot: ws,
    metadata: { task_goal: 'old goal' },
  });

  const result = taskDb.chatTask(db, {
    id,
    actor: 'tester',
    goal: 'ship the thing',
    summary: 'first pass done',
  });

  assert.strictEqual(result.chatted, true);
  assert.strictEqual(result.goal_changed, true);
  assert.strictEqual(result.row.metadata.task_goal, 'ship the thing');
  assert.strictEqual(result.row.metadata.goal_objective, 'ship the thing');
  assert.strictEqual(result.row.metadata.objective, 'ship the thing');
  assert.strictEqual(result.row.metadata.task_summary, 'first pass done');
  assert.strictEqual(result.row.metadata.task_refined_by, 'tester');
  assert.strictEqual(typeof result.row.metadata.task_refined_at, 'string');
  assert.strictEqual(result.event.payload.previous_goal, 'old goal');
  assert.ok(result.chat_packet.includes('goal: ship the thing'));
  assert.ok(result.chat_packet.includes('summary: first pass done'));

  const again = taskDb.chatTask(db, { id, actor: 'tester', goal: 'ship the thing' });
  assert.strictEqual(again.chatted, true);
  assert.strictEqual(again.goal_changed, false);
  assert.strictEqual(again.event.payload.previous_goal, null);
});

test('chatTask rejects missing input and unknown tasks', () => {
  assert.throws(() => taskDb.chatTask(db, {}), /id required/);

  const { id } = taskDb.addTask(db, { title: 'quiet task', workspaceRoot: ws });
  assert.deepStrictEqual(
    taskDb.chatTask(db, { id }),
    { chatted: false, reason: 'content_required' },
  );
  assert.deepStrictEqual(
    taskDb.chatTask(db, { id, content: '   \n  ' }),
    { chatted: false, reason: 'content_required' },
  );
  assert.deepStrictEqual(
    taskDb.chatTask(db, { id: 'NO_SUCH_TASK', content: 'hi' }),
    { chatted: false, reason: 'not_found' },
  );
});

test('chatTask refuses tasks that already ended', () => {
  const done = taskDb.addTask(db, { title: 'finished task', workspaceRoot: ws, status: 'done' });
  const failed = taskDb.addTask(db, { title: 'broken task', workspaceRoot: ws, status: 'failed' });

  assert.deepStrictEqual(
    taskDb.chatTask(db, { id: done.id, content: 'still here' }),
    { chatted: false, reason: 'already_done' },
  );
  assert.deepStrictEqual(
    taskDb.chatTask(db, { id: failed.id, content: 'still here' }),
    { chatted: false, reason: 'already_failed' },
  );
});
