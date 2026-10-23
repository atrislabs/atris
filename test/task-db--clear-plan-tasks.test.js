'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const taskDb = require('../lib/task-db');

// clearPlanTasks reads no ATRIS_* env itself, but the db helpers it calls can
// fall back to them, so keep the run independent of the machine it runs on.
for (const key of Object.keys(process.env)) {
  if (key.startsWith('ATRIS_')) delete process.env[key];
}

// Every db lives in a fresh temp dir. Passing the db path explicitly means
// nothing resolves through HOME or the real ~/.atris store.
function freshWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-db-clear-plan-'));
  const ws = path.join(dir, 'workspace');
  fs.mkdirSync(ws);
  const db = taskDb.open(path.join(dir, 'tasks.db'));
  return { dir, ws, db };
}

function cleanup({ dir }) {
  taskDb.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

const PLANNED_METADATA = {
  stage: 'plan',
  stage_owner: 'builder-bot',
  stage_goal: 'ship the parser',
  verify: 'node --test test/parser.test.js',
  exit_condition: 'parser tests green',
  planned_at: '2026-10-01T09:00:00.000Z',
};

test('clearPlanTasks backlogs plan-shaped open tasks and leaves plain ones alone', () => {
  const env = freshWorkspace();
  try {
    const { db, ws } = env;
    const planned = taskDb.addTask(db, {
      title: 'Plan the parser',
      tag: 'plan',
      workspaceRoot: ws,
      metadata: PLANNED_METADATA,
    });
    // No plan tag and no plan metadata, but a verify command counts as a plan signal.
    const verifyOnly = taskDb.addTask(db, {
      title: 'Check the export',
      tag: 'ops',
      workspaceRoot: ws,
      metadata: { verify: 'node --test test/export.test.js' },
    });
    const plain = taskDb.addTask(db, { title: 'Buy coffee', tag: 'capture', workspaceRoot: ws });

    const result = taskDb.clearPlanTasks(db, { workspaceRoot: ws, actor: 'keshav', reason: 'sweep' });

    assert.deepStrictEqual(result.skipped, []);
    assert.deepStrictEqual(
      result.cleared.map((row) => row.id).sort(),
      [planned.id, verifyOnly.id].sort(),
    );

    for (const row of result.cleared) {
      assert.strictEqual(row.status, 'open');
      assert.strictEqual(row.tag, 'capture');
      assert.strictEqual(row.metadata.backlog_reason, 'sweep');
      assert.strictEqual(row.metadata.backlogged_by, 'keshav');
      assert.strictEqual(row.metadata.verify, undefined);
      assert.strictEqual(row.metadata.stage, undefined);
      assert.strictEqual(row.metadata.stage_owner, undefined);
      assert.strictEqual(row.metadata.planned_at, undefined);
    }

    // The stage goal is not lost: it is moved to task_goal before the plan keys are removed.
    const plannedRow = taskDb.getTask(db, planned.id);
    assert.strictEqual(plannedRow.metadata.task_goal, 'ship the parser');
    assert.strictEqual(plannedRow.metadata.stage_goal, undefined);

    const plainRow = taskDb.getTask(db, plain.id);
    assert.strictEqual(plainRow.tag, 'capture');
    assert.strictEqual(plainRow.metadata.backlog_reason, undefined);
    assert.strictEqual(plainRow.metadata.backlogged_by, undefined);

    const events = taskDb.listTaskEvents(db, { taskId: planned.id, order: 'asc' });
    assert.ok(events.some((event) => event.event_type === 'task_backlogged'));
  } finally {
    cleanup(env);
  }
});

test('clearPlanTasks writes the requested tag and records the old one', () => {
  const env = freshWorkspace();
  try {
    const { db, ws } = env;
    const only = taskDb.addTask(db, {
      title: 'Shape the importer',
      tag: 'plan',
      workspaceRoot: ws,
      metadata: PLANNED_METADATA,
    });
    const tagged = taskDb.clearPlanTasks(db, { workspaceRoot: ws, tag: 'someday' });
    assert.strictEqual(tagged.cleared.length, 1);
    assert.strictEqual(tagged.cleared[0].id, only.id);
    assert.strictEqual(tagged.cleared[0].tag, 'someday');
    assert.strictEqual(tagged.cleared[0].metadata.backlog_previous_tag, 'plan');
  } finally {
    cleanup(env);
  }
});

test('clearPlanTasks with limit only clears up to that many plan tasks', () => {
  const env = freshWorkspace();
  try {
    const { db, ws } = env;
    // Only plan tasks in this workspace, so any two of them are a valid pick.
    for (const title of ['Plan A', 'Plan B', 'Plan C']) {
      taskDb.addTask(db, { title, tag: 'plan', workspaceRoot: ws, metadata: PLANNED_METADATA });
    }
    const limited = taskDb.clearPlanTasks(db, { workspaceRoot: ws, limit: 2 });
    assert.strictEqual(limited.cleared.length, 2);
    assert.strictEqual(limited.skipped.length, 0);

    // One plan task was not picked up, so it still carries its plan tag.
    const stillPlanned = taskDb.listTasks(db, { workspaceRoot: ws, status: 'open' })
      .filter((row) => row.tag === 'plan');
    assert.strictEqual(stillPlanned.length, 1);
  } finally {
    cleanup(env);
  }
});

test('clearPlanTasks on an empty store, or with only other workspaces, clears nothing', () => {
  const env = freshWorkspace();
  try {
    const { db, ws, dir } = env;
    assert.deepStrictEqual(
      taskDb.clearPlanTasks(db, { workspaceRoot: ws, actor: 'keshav' }),
      { cleared: [], skipped: [] },
    );

    const otherWs = path.join(dir, 'other-workspace');
    fs.mkdirSync(otherWs);
    const elsewhere = taskDb.addTask(db, {
      title: 'Plan in another repo',
      tag: 'plan',
      workspaceRoot: otherWs,
      metadata: PLANNED_METADATA,
    });

    const result = taskDb.clearPlanTasks(db, { workspaceRoot: ws, actor: 'keshav' });
    assert.deepStrictEqual(result, { cleared: [], skipped: [] });

    const untouched = taskDb.getTask(db, elsewhere.id);
    assert.strictEqual(untouched.tag, 'plan');
    assert.strictEqual(untouched.metadata.backlog_reason, undefined);
  } finally {
    cleanup(env);
  }
});
