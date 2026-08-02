'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const taskStore = require('../lib/task-db');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

function makeWorkspace() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-task-hygiene-')));
  fs.mkdirSync(path.join(root, 'atris'), { recursive: true });
  fs.mkdirSync(path.join(root, '.atris', 'state'), { recursive: true });
  return root;
}

function runCli(args, { cwd, env }) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 30000,
    env: {
      ...process.env,
      ATRIS_SKIP_UPDATE_CHECK: '1',
      NODE_NO_WARNINGS: '1',
      ...env,
    },
  });
  if (result.error) throw result.error;
  return result;
}

function addBlocker(db, root, { missionId, status = 'open', blockerClass = 'runner-failed', tag = 'mission-blocker' }) {
  return taskStore.addTask(db, {
    title: `unblock ${missionId}`,
    tag,
    workspaceRoot: root,
    status,
    claimedBy: status === 'claimed' || status === 'review' ? 'worker' : null,
    metadata: {
      mission_id: missionId,
      mission_blocker_class: blockerClass,
      verify: 'node --test test/self-drive.test.js',
    },
  }).id;
}

test('task creation marks missing and diff-only verification as degraded', () => {
  const root = makeWorkspace();
  const dbPath = path.join(root, 'tasks.db');
  try {
    const db = taskStore.open(dbPath);
    const missingId = taskStore.addTask(db, {
      title: 'missing verifier',
      workspaceRoot: root,
      sourceKey: 'creation-gate:missing',
    }).id;
    const diffOnlyId = taskStore.addTask(db, {
      title: 'diff-only verifier',
      workspaceRoot: root,
      metadata: { verify: '  git diff --check  ' },
    }).id;
    const strongId = taskStore.addTask(db, {
      title: 'runnable verifier',
      workspaceRoot: root,
      metadata: { verify: 'node --test test/self-drive.test.js' },
    }).id;

    assert.deepEqual(
      [taskStore.getTask(db, missingId).metadata.verification_status, taskStore.getTask(db, missingId).metadata.verification_degraded_reason],
      ['degraded', 'missing_verify'],
    );
    assert.deepEqual(
      [taskStore.getTask(db, diffOnlyId).metadata.verification_status, taskStore.getTask(db, diffOnlyId).metadata.verification_degraded_reason],
      ['degraded', 'diff_only_verify'],
    );
    assert.equal(taskStore.getTask(db, strongId).metadata.verification_status, undefined);

    const duplicate = taskStore.addTask(db, {
      title: 'same source with a later verifier',
      workspaceRoot: root,
      sourceKey: 'creation-gate:missing',
      metadata: { verify: 'npm test' },
    });
    assert.equal(duplicate.inserted, false);
    assert.equal(taskStore.getTask(db, missingId).metadata.verification_degraded_reason, 'missing_verify');
  } finally {
    taskStore.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('task add exposes degraded verification and accepts a runnable verifier', () => {
  const root = makeWorkspace();
  const env = { ATRIS_TASKS_DB: path.join(root, 'tasks.db'), ATRIS_AGENT_PROOF_ONLY: '0' };
  try {
    const degraded = runCli(['task', 'add', 'task without a check', '--json'], { cwd: root, env });
    assert.equal(degraded.status, 0, degraded.stderr);
    const degradedTask = JSON.parse(degraded.stdout).task;
    const shownDegraded = runCli(['task', 'show', degradedTask.display_id, '--json'], { cwd: root, env });
    assert.equal(shownDegraded.status, 0, shownDegraded.stderr);
    assert.equal(JSON.parse(shownDegraded.stdout).metadata.verification_status, 'degraded');
    assert.equal(JSON.parse(shownDegraded.stdout).metadata.verification_degraded_reason, 'missing_verify');
    const shownText = runCli(['task', 'show', degradedTask.display_id], { cwd: root, env });
    assert.equal(shownText.status, 0, shownText.stderr);
    assert.match(shownText.stdout, /verification: degraded \(missing verify command\)/);

    const verified = runCli([
      'task', 'add', 'task with a real check', '--verify', 'node --test test/self-drive.test.js', '--json',
    ], { cwd: root, env });
    assert.equal(verified.status, 0, verified.stderr);
    const verifiedTask = JSON.parse(verified.stdout).task;
    assert.equal(verifiedTask.metadata.verify, 'node --test test/self-drive.test.js');
    assert.equal(verifiedTask.metadata.verification_status, undefined);
  } finally {
    taskStore.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('task reaper closes blocker rows for complete and stopped missions only', () => {
  const root = makeWorkspace();
  const dbPath = path.join(root, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, ATRIS_AGENT_PROOF_ONLY: '0', ATRIS_AGENT_ID: 'reaper-test' };
  try {
    fs.writeFileSync(path.join(root, '.atris', 'state', 'missions.jsonl'), [
      JSON.stringify({ id: 'mission-complete', objective: 'complete work', status: 'complete', updated_at: '2026-08-02T10:00:00.000Z' }),
      JSON.stringify({ id: 'mission-stopped', objective: 'stopped work', status: 'stopped', updated_at: '2026-08-02T10:01:00.000Z' }),
      JSON.stringify({ id: 'mission-active', objective: 'active work', status: 'active', updated_at: '2026-08-02T10:02:00.000Z' }),
    ].join('\n') + '\n', 'utf8');

    const db = taskStore.open(dbPath);
    const completeOpen = addBlocker(db, root, { missionId: 'mission-complete' });
    const completeReview = addBlocker(db, root, { missionId: 'mission-complete', status: 'review', blockerClass: 'review-stuck' });
    const stoppedClaimed = addBlocker(db, root, { missionId: 'mission-stopped', status: 'claimed' });
    const activeOpen = addBlocker(db, root, { missionId: 'mission-active' });
    const regularOpen = addBlocker(db, root, { missionId: 'mission-complete', tag: 'feature', blockerClass: 'not-a-blocker' });
    taskStore.close();

    const first = runCli(['task', 'reap-mission-blockers', '--json'], { cwd: root, env });
    assert.equal(first.status, 0, first.stderr);
    const payload = JSON.parse(first.stdout);
    assert.equal(payload.action, 'reaped_mission_blockers');
    assert.equal(payload.closed_count, 3);
    assert.deepEqual(new Set(payload.closed.map(row => row.mission_status)), new Set(['complete', 'stopped']));
    assert.ok(payload.closed.every(row => /^[A-Z0-9]{2,4}-\d+$/.test(row.task_ref)), JSON.stringify(payload.closed));

    const checkedDb = taskStore.open(dbPath);
    assert.equal(taskStore.getTask(checkedDb, completeOpen).status, 'archived');
    assert.equal(taskStore.getTask(checkedDb, completeReview).status, 'archived');
    assert.equal(taskStore.getTask(checkedDb, stoppedClaimed).status, 'archived');
    assert.equal(taskStore.getTask(checkedDb, activeOpen).status, 'open');
    assert.equal(taskStore.getTask(checkedDb, regularOpen).status, 'open');
    const events = taskStore.listTaskEvents(checkedDb, { taskId: completeReview });
    assert.equal(events.at(-1).event_type, 'archived');
    assert.equal(events.at(-1).payload.reason, 'mission mission-complete is complete');
    assert.equal(taskStore.getTask(checkedDb, completeReview).metadata.archived_reason, 'mission mission-complete is complete');
    taskStore.close();

    const second = runCli(['task', 'reap-mission-blockers', '--json'], { cwd: root, env });
    assert.equal(second.status, 0, second.stderr);
    assert.equal(JSON.parse(second.stdout).closed_count, 0);
  } finally {
    taskStore.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
