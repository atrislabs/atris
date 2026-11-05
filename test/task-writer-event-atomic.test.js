'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tasks = require('../lib/task-db');

for (const kind of ['tag', 'chat', 'plan', 'reopen', 'backlog']) {
  test(`${kind} rolls back its failed event inside a caller transaction that continues`, () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'task-nested-atomic-'));
    const db = tasks.open(path.join(tmp, 'tasks.db'));
    try {
      const { id } = tasks.addTask(db, { title: 'test task', workspaceRoot: tmp, metadata: { stage: 'plan', task_goal: 'goal', verify: 'node --test', exit_condition: 'done' } });
      const other = tasks.addTask(db, { title: 'other task', workspaceRoot: tmp }).id;
      if (kind === 'reopen') db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(id);
      const before = tasks.getTask(db, id);
      const eventType = { tag: 'task_tags_updated', chat: 'task_chat', plan: 'task_planned', reopen: 'reopened', backlog: 'task_backlogged' }[kind];
      db.exec(`CREATE TRIGGER fail_event BEFORE INSERT ON task_events WHEN NEW.event_type = '${eventType}' BEGIN SELECT RAISE(ABORT, 'test failure'); END`);
      db.exec('BEGIN IMMEDIATE');
      assert.throws(() => {
        if (kind === 'tag') tasks.tagTask(db, { id, actor: 'test', add: ['priority'] });
        else if (kind === 'chat') tasks.chatTask(db, { id, actor: 'test', goal: 'new goal' });
        else if (kind === 'plan') tasks.stageTask(db, { id, actor: 'test', stage: 'plan', goal: 'new goal', exit: 'done', proofNeeded: 'node --test' });
        else if (kind === 'reopen') tasks.reopenTask(db, { id, actor: 'test' });
        else tasks.backlogTask(db, { id, actor: 'test' });
      }, /test failure/);
      db.prepare('UPDATE tasks SET title = ? WHERE id = ?').run('outer work kept', other);
      db.exec('COMMIT');
      assert.deepEqual(tasks.getTask(db, id), before);
      assert.equal(tasks.getTask(db, other).title, 'outer work kept');
      assert.equal(tasks.listTaskEvents(db, { taskId: id }).some((event) => event.event_type === eventType), false);
    } finally {
      tasks.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

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

test('successful nested task write remains governed by caller rollback', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'task-nested-rollback-'));
  const db = tasks.open(path.join(tmp, 'tasks.db'));
  try {
    const { id } = tasks.addTask(db, { title: 'test task', workspaceRoot: tmp });
    const before = tasks.getTask(db, id);
    db.exec('BEGIN IMMEDIATE');
    assert.equal(tasks.tagTask(db, { id, actor: 'test', add: ['priority'] }).tagged, true);
    db.exec('ROLLBACK');
    assert.deepEqual(tasks.getTask(db, id), before);
    assert.equal(tasks.listTaskEvents(db, { taskId: id }).some((event) => event.event_type === 'task_tags_updated'), false);
  } finally {
    tasks.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('nested failure is rolled back when the SQLite binding has no isTransaction property', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'task-nested-legacy-'));
  const db = tasks.open(path.join(tmp, 'tasks.db'));
  try {
    const { id } = tasks.addTask(db, { title: 'test task', workspaceRoot: tmp });
    const before = tasks.getTask(db, id);
    db.exec("CREATE TRIGGER fail_event BEFORE INSERT ON task_events WHEN NEW.event_type = 'task_tags_updated' BEGIN SELECT RAISE(ABORT, 'test failure'); END");
    const legacyDb = { exec: db.exec.bind(db), prepare: db.prepare.bind(db) };
    db.exec('BEGIN IMMEDIATE');
    assert.throws(() => tasks.tagTask(legacyDb, { id, actor: 'test', add: ['priority'] }), /test failure/);
    db.exec('COMMIT');
    assert.deepEqual(tasks.getTask(db, id), before);
  } finally {
    tasks.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

for (const kind of ['result', 'revise', 'review', 'archive']) {
  test(`${kind} rolls back its failed event when an outer caller catches the error`, () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'task-nested-more-'));
    const db = tasks.open(path.join(tmp, 'tasks.db'));
    try {
      const { id } = tasks.addTask(db, { title: 'test task', workspaceRoot: tmp });
      if (kind !== 'result') db.prepare("UPDATE tasks SET status = 'review' WHERE id = ?").run(id);
      const before = tasks.getTask(db, id);
      const eventType = { result: 'result_set', revise: 'revision_requested', review: 'reviewed', archive: 'archived' }[kind];
      db.exec(`CREATE TRIGGER fail_event BEFORE INSERT ON task_events WHEN NEW.event_type = '${eventType}' BEGIN SELECT RAISE(ABORT, 'test failure'); END`);
      db.exec('BEGIN IMMEDIATE');
      assert.throws(() => {
        if (kind === 'result') tasks.setTaskResult(db, { id, actor: 'test', result: 'done' });
        else if (kind === 'revise') tasks.reviseTask(db, { id, actor: 'test', note: 'Please revise' });
        else if (kind === 'review') tasks.reviewTask(db, { id, actor: 'test', reward: 0, landing: { checked: 'Checked it' } });
        else tasks.archiveTask(db, { id, actor: 'test', reason: 'No longer needed', skipLogs: true });
      }, /test failure/);
      db.exec('COMMIT');
      assert.deepEqual(tasks.getTask(db, id), before);
      assert.equal(tasks.listTaskEvents(db, { taskId: id }).some((event) => event.event_type === eventType), false);
    } finally {
      tasks.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
}

for (const final of ['done', 'failed']) {
  for (const outer of [false, true]) {
    test(`${final} event failure preserves task state${outer ? ' inside caller transaction' : ''}`, () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'task-done-atomic-'));
      const db = tasks.open(path.join(tmp, 'tasks.db'));
      try {
        const { id } = tasks.addTask(db, { title: 'test task', workspaceRoot: tmp });
        const before = tasks.getTask(db, id);
        fs.mkdirSync(path.join(tmp, 'atris'));
        const eventType = final === 'done' ? 'completed' : 'blocked';
        db.exec(`CREATE TRIGGER fail_event BEFORE INSERT ON task_events WHEN NEW.event_type = '${eventType}' BEGIN SELECT RAISE(ABORT, 'test failure'); END`);
        if (outer) db.exec('BEGIN IMMEDIATE');
        assert.throws(() => tasks.doneTask(db, { id, actor: 'test', status: final }), /test failure/);
        if (outer) db.exec('COMMIT');
        assert.deepEqual(tasks.getTask(db, id), before);
        assert.deepEqual(fs.readdirSync(path.join(tmp, 'atris')), []);
      } finally {
        tasks.close();
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
  }
}

test('successful completion joins and rolls back with caller transaction', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'task-done-outer-'));
  const db = tasks.open(path.join(tmp, 'tasks.db'));
  try {
    const { id } = tasks.addTask(db, { title: 'test task', workspaceRoot: tmp });
    const before = tasks.getTask(db, id);
    db.exec('BEGIN IMMEDIATE');
    assert.equal(tasks.doneTask(db, { id, actor: 'test' }).updated, true);
    assert.equal(tasks.getTask(db, id).status, 'done');
    db.exec('ROLLBACK');
    assert.deepEqual(tasks.getTask(db, id), before);
    assert.equal(tasks.listTaskEvents(db, { taskId: id }).some((e) => e.event_type === 'completed'), false);
  } finally {
    tasks.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
