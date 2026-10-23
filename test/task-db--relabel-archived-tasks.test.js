'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  open,
  close,
  addTask,
  getTask,
  listTaskEvents,
  relabelArchivedTasks,
} = require('../lib/task-db');

function createIsolatedContext() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-relabel-archived-test-'));
  const savedEnv = { ...process.env };

  process.env.HOME = tmpDir;
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('ATRIS_')) {
      delete process.env[key];
    }
  }

  const dbPath = path.join(tmpDir, 'tasks.db');
  process.env.ATRIS_TASKS_DB = dbPath;

  close();
  const db = open(dbPath);

  function cleanup() {
    close();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_) {}
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, savedEnv);
  }

  return { tmpDir, db, cleanup };
}

test('relabelArchivedTasks dry-run previews matches and apply updates failed tasks to archived', () => {
  const { tmpDir, db, cleanup } = createIsolatedContext();
  try {
    const ws = tmpDir;
    const task1 = addTask(db, {
      title: 'Reset candidate 1',
      workspaceRoot: ws,
      status: 'failed',
      metadata: {
        archived_at: '2026-06-10T06:05:18.736Z',
        archive_reason: 'First-principles backlog reset 2026-06-10: archived off-roadmap tasks',
      },
    });

    const task2 = addTask(db, {
      title: 'Reset candidate 2',
      workspaceRoot: ws,
      status: 'failed',
      metadata: {
        archived_at: '2026-06-10T07:15:00.000Z',
        archive_reason: 'first-principles backlog reset 2026-06-10: cleanup',
      },
    });

    const unrelatedTask = addTask(db, {
      title: 'Genuine test failure',
      workspaceRoot: ws,
      status: 'failed',
      metadata: {
        error: 'Assertion failed during run',
      },
    });

    // Dry-run mode: should preview candidates without mutating them
    const preview = relabelArchivedTasks(db, { workspaceRoot: ws, apply: false });
    assert.strictEqual(preview.applied, false);
    assert.strictEqual(preview.count, 2);
    assert.strictEqual(preview.sample.length, 2);
    const sampleIds = preview.sample.map(s => s.id);
    assert.ok(sampleIds.includes(task1.id));
    assert.ok(sampleIds.includes(task2.id));

    const task1Before = getTask(db, task1.id);
    assert.strictEqual(task1Before.status, 'failed');
    assert.strictEqual(task1Before.metadata.relabeled_from_status, undefined);

    // Apply mode: relabels candidates to archived and writes events/metadata
    const result = relabelArchivedTasks(db, {
      workspaceRoot: ws,
      apply: true,
      actor: 'test-migrator',
    });
    assert.strictEqual(result.applied, true);
    assert.strictEqual(result.count, 2);
    assert.strictEqual(result.ids.length, 2);
    assert.ok(result.ids.includes(task1.id));
    assert.ok(result.ids.includes(task2.id));

    // Candidate 1 updated
    const task1After = getTask(db, task1.id);
    assert.strictEqual(task1After.status, 'archived');
    assert.strictEqual(task1After.metadata.relabeled_from_status, 'failed');
    assert.strictEqual(task1After.metadata.relabeled_by, 'test-migrator');
    assert.strictEqual(task1After.metadata.relabel_reason, 'obl_1622_june_10_backlog_reset_relabel');
    assert.strictEqual(task1After.metadata.archived_at, '2026-06-10T06:05:18.736Z');
    assert.ok(typeof task1After.metadata.relabeled_at === 'string');

    // Candidate 2 updated
    const task2After = getTask(db, task2.id);
    assert.strictEqual(task2After.status, 'archived');
    assert.strictEqual(task2After.metadata.relabeled_from_status, 'failed');
    assert.strictEqual(task2After.metadata.relabeled_by, 'test-migrator');

    // Unrelated failed task remains untouched
    const unrelatedAfter = getTask(db, unrelatedTask.id);
    assert.strictEqual(unrelatedAfter.status, 'failed');
    assert.strictEqual(unrelatedAfter.metadata.relabeled_from_status, undefined);

    // Event audit trail appended for relabeled task
    const events = listTaskEvents(db, { taskId: task1.id });
    const relabelEvent = events.find(e => e.event_type === 'relabeled_archived');
    assert.ok(relabelEvent, 'event relabeled_archived should be recorded');
    assert.strictEqual(relabelEvent.actor, 'test-migrator');
    assert.deepStrictEqual(relabelEvent.payload, {
      previous_status: 'failed',
      reason: 'obl_1622_june_10_backlog_reset_relabel',
    });

    // Re-running apply is idempotent
    const secondPass = relabelArchivedTasks(db, { workspaceRoot: ws, apply: true });
    assert.strictEqual(secondPass.applied, true);
    assert.strictEqual(secondPass.count, 0);
    assert.deepStrictEqual(secondPass.ids, []);
  } finally {
    cleanup();
  }
});

test('relabelArchivedTasks edge cases: non-matching status, missing metadata, workspace filtering, and limit', () => {
  const { tmpDir, db, cleanup } = createIsolatedContext();
  try {
    const ws = tmpDir;
    const otherWs = path.join(tmpDir, 'other-workspace');
    fs.mkdirSync(otherWs, { recursive: true });

    // Open task with marker must not be selected
    const openTask = addTask(db, {
      title: 'Open task with reset marker',
      workspaceRoot: ws,
      status: 'open',
      metadata: {
        archived_at: '2026-06-10T06:05:18.736Z',
        archive_reason: 'First-principles backlog reset 2026-06-10: off-roadmap',
      },
    });

    // Failed task missing archived_at must not be selected
    const missingArchivedAt = addTask(db, {
      title: 'Failed without archived_at',
      workspaceRoot: ws,
      status: 'failed',
      metadata: {
        archive_reason: 'First-principles backlog reset 2026-06-10: off-roadmap',
      },
    });

    // Failed task with non-matching archive reason must not be selected
    const differentReason = addTask(db, {
      title: 'Failed with routine cleanup reason',
      workspaceRoot: ws,
      status: 'failed',
      metadata: {
        archived_at: '2026-06-10T06:05:18.736Z',
        archive_reason: 'Manual cleanup pass on 2026-06-10',
      },
    });

    // Matching task in a different workspace
    const otherWsTask = addTask(db, {
      title: 'Other workspace reset candidate',
      workspaceRoot: otherWs,
      status: 'failed',
      metadata: {
        archived_at: '2026-06-10T06:05:18.736Z',
        archive_reason: 'First-principles backlog reset 2026-06-10: off-roadmap',
      },
    });

    // Two valid candidates in ws
    const candidateA = addTask(db, {
      title: 'Candidate A',
      workspaceRoot: ws,
      status: 'failed',
      metadata: {
        archived_at: '2026-06-10T06:05:18.736Z',
        archive_reason: 'First-principles backlog reset 2026-06-10: part A',
      },
    });
    const candidateB = addTask(db, {
      title: 'Candidate B',
      workspaceRoot: ws,
      status: 'failed',
      metadata: {
        archived_at: '2026-06-10T06:05:18.736Z',
        archive_reason: 'First-principles backlog reset 2026-06-10: part B',
      },
    });

    // Limit restricts candidate count
    const limited = relabelArchivedTasks(db, { workspaceRoot: ws, apply: false, limit: 1 });
    assert.strictEqual(limited.count, 1);
    assert.strictEqual(limited.sample.length, 1);

    // Apply with workspaceRoot scope relabels only matching tasks in ws
    const applied = relabelArchivedTasks(db, { workspaceRoot: ws, apply: true, actor: 'migrator' });
    assert.strictEqual(applied.count, 2);
    assert.deepStrictEqual(applied.ids.sort(), [candidateA.id, candidateB.id].sort());

    // Non-candidates remain unchanged
    assert.strictEqual(getTask(db, openTask.id).status, 'open');
    assert.strictEqual(getTask(db, missingArchivedAt.id).status, 'failed');
    assert.strictEqual(getTask(db, differentReason.id).status, 'failed');
    assert.strictEqual(getTask(db, otherWsTask.id).status, 'failed');
  } finally {
    cleanup();
  }
});

test('relabelArchivedTasks handles empty candidate cases gracefully', () => {
  const { tmpDir, db, cleanup } = createIsolatedContext();
  try {
    const ws = tmpDir;

    // Dry-run on empty database
    const dry = relabelArchivedTasks(db, { workspaceRoot: ws, apply: false });
    assert.strictEqual(dry.applied, false);
    assert.strictEqual(dry.count, 0);
    assert.deepStrictEqual(dry.sample, []);

    // Apply on empty database
    const applied = relabelArchivedTasks(db, { workspaceRoot: ws, apply: true, actor: 'migrator' });
    assert.strictEqual(applied.applied, true);
    assert.strictEqual(applied.count, 0);
    assert.deepStrictEqual(applied.ids, []);
    assert.deepStrictEqual(applied.sample, []);
  } finally {
    cleanup();
  }
});
