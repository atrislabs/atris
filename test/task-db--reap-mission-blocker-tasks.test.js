'use strict';

// reapMissionBlockerTasks archives open mission-blocker tasks whose mission has
// ended (complete or stopped). Each test gets a real sqlite task db in a temp
// dir, fixed mission objects, and an explicit actor, so nothing depends on the
// clock, the home directory, or ATRIS_* env vars.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const taskDb = require('../lib/task-db');

function clearAtrisEnv() {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('ATRIS_')) delete process.env[key];
  }
}

function restoreEnv(saved) {
  for (const key of Object.keys(process.env)) {
    if (!(key in saved)) delete process.env[key];
  }
  Object.assign(process.env, saved);
}

function withTempDb(run) {
  const saved = { ...process.env };
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-reap-blockers-')));
  try {
    clearAtrisEnv();
    process.env.HOME = base;
    const ws = path.join(base, 'workspace');
    fs.mkdirSync(ws);
    const db = taskDb.open(path.join(base, 'tasks.db'));
    return run({ db, ws });
  } finally {
    taskDb.close();
    restoreEnv(saved);
    fs.rmSync(base, { recursive: true, force: true });
  }
}

function blocker(db, ws, { title, missionId, blockerClass = 'needs_credentials', tag = 'mission-blocker', status, claimedBy }) {
  return taskDb.addTask(db, {
    title,
    tag,
    workspaceRoot: ws,
    status,
    claimedBy,
    metadata: { mission_id: missionId, mission_blocker_class: blockerClass },
  });
}

test('archives open mission-blocker tasks only when their mission has ended', () => {
  withTempDb(({ db, ws }) => {
    const ended = blocker(db, ws, { title: 'Unblock mission alpha', missionId: 'm-alpha' });
    const live = blocker(db, ws, { title: 'Unblock mission beta', missionId: 'm-beta' });

    const result = taskDb.reapMissionBlockerTasks(db, {
      workspaceRoot: ws,
      missions: [
        { id: 'm-alpha', status: 'complete' },
        { id: 'm-beta', status: 'running' },
      ],
      actor: 'test-reaper',
      skipLogs: true,
    });

    assert.deepStrictEqual(result, {
      count: 1,
      closed: [{
        task_id: ended.id,
        title: 'Unblock mission alpha',
        previous_status: 'open',
        mission_id: 'm-alpha',
        mission_status: 'complete',
        blocker_class: 'needs_credentials',
        reason: 'mission m-alpha is complete',
      }],
    });

    const archived = taskDb.getTask(db, ended.id);
    assert.strictEqual(archived.status, 'archived');
    assert.strictEqual(archived.metadata.archived_reason, 'mission m-alpha is complete');
    assert.strictEqual(archived.metadata.archived_by, 'test-reaper');

    assert.strictEqual(taskDb.getTask(db, live.id).status, 'open');
  });
});

test('matches mission status regardless of case and skips non-matching candidates', () => {
  withTempDb(({ db, ws }) => {
    const stopped = blocker(db, ws, { title: 'Stopped mission blocker', missionId: 'm-stopped', status: 'claimed', claimedBy: 'worker-1' });
    const inReview = blocker(db, ws, { title: 'Review mission blocker', missionId: 'm-review', status: 'review', claimedBy: 'worker-2' });
    const alreadyDone = blocker(db, ws, { title: 'Done mission blocker', missionId: 'm-stopped', status: 'done' });
    const wrongTag = blocker(db, ws, { title: 'Wrong tag', missionId: 'm-stopped', tag: 'feature' });
    const noClass = taskDb.addTask(db, {
      title: 'No blocker class',
      tag: 'mission-blocker',
      workspaceRoot: ws,
      metadata: { mission_id: 'm-stopped' },
    });
    const unknownMission = blocker(db, ws, { title: 'Unknown mission', missionId: 'm-missing' });

    const result = taskDb.reapMissionBlockerTasks(db, {
      workspaceRoot: ws,
      missions: [
        { id: 'm-stopped', status: 'Stopped' },
        { id: 'm-review', status: 'COMPLETE' },
      ],
      actor: 'test-reaper',
      skipLogs: true,
    });

    assert.strictEqual(result.count, 2);
    const closedById = new Map(result.closed.map(entry => [entry.task_id, entry]));
    assert.deepStrictEqual([...closedById.keys()].sort(), [stopped.id, inReview.id].sort());
    assert.strictEqual(closedById.get(stopped.id).previous_status, 'claimed');
    assert.strictEqual(closedById.get(stopped.id).mission_status, 'stopped');
    assert.strictEqual(closedById.get(inReview.id).previous_status, 'review');
    assert.strictEqual(closedById.get(inReview.id).mission_status, 'complete');

    assert.strictEqual(taskDb.getTask(db, stopped.id).status, 'archived');
    assert.strictEqual(taskDb.getTask(db, inReview.id).status, 'archived');
    assert.strictEqual(taskDb.getTask(db, alreadyDone.id).status, 'done');
    assert.strictEqual(taskDb.getTask(db, wrongTag.id).status, 'open');
    assert.strictEqual(taskDb.getTask(db, noClass.id).status, 'open');
    assert.strictEqual(taskDb.getTask(db, unknownMission.id).status, 'open');
  });
});

test('returns an empty result when no mission has ended or input is empty', () => {
  withTempDb(({ db, ws }) => {
    const task = blocker(db, ws, { title: 'Still waiting', missionId: 'm-live' });

    const noMissions = taskDb.reapMissionBlockerTasks(db, { workspaceRoot: ws, actor: 'test-reaper', skipLogs: true });
    assert.deepStrictEqual(noMissions, { closed: [], count: 0 });

    const junkMissions = taskDb.reapMissionBlockerTasks(db, {
      workspaceRoot: ws,
      missions: [null, {}, { status: 'complete' }, { id: 'm-live', status: 'running' }],
      actor: 'test-reaper',
      skipLogs: true,
    });
    assert.deepStrictEqual(junkMissions, { closed: [], count: 0 });

    const noRows = taskDb.reapMissionBlockerTasks(db, {
      workspaceRoot: ws,
      missions: [{ id: 'm-live', status: 'complete' }],
      rows: [],
      actor: 'test-reaper',
      skipLogs: true,
    });
    assert.deepStrictEqual(noRows, { closed: [], count: 0 });

    assert.strictEqual(taskDb.getTask(db, task.id).status, 'open');
  });
});
