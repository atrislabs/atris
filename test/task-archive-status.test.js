'use strict';

// OBL-1622: bulk sweeps (duplicates, off-roadmap cleanup) must write a distinct
// 'archived' status, never 'failed' — 'failed' is a reward signal and mislabeling
// good work as failed corrupts it (see atris/reports/failed-tasks-analysis-2026-07-03.md).
// This also covers the one-time `atris task relabel-archived` migration that fixes
// the 125 rows the 2026-06-10 backlog reset mislabeled as failed.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

function hasNodeSqlite() {
  const result = spawnSync(process.execPath, ['-e', 'require("node:sqlite")'], {
    encoding: 'utf8',
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  });
  return result.status === 0;
}

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-task-archive-test-'));
}

function cleanupTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function runCli(args, { cwd, env } = {}) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 20000,
    env: {
      ...process.env,
      ATRIS_SKIP_UPDATE_CHECK: '1',
      ...(env || {}),
    },
  });
  if (result.error) throw result.error;
  return result;
}

test('atris task archive writes status archived, not failed', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const env = { ATRIS_TASKS_DB: path.join(dir, 'tasks.db'), NODE_NO_WARNINGS: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const created = runCli(['task', 'new', 'Duplicate loop-tick sweep candidate', '--tag', 'archive-test', '--json'], { cwd: dir, env });
    assert.equal(created.status, 0, created.stderr);
    const task = JSON.parse(created.stdout).task;

    const archived = runCli(['task', 'archive', task.display_id, '--reason', 'duplicate loop-tick left claimed in Do', '--json'], { cwd: dir, env });
    assert.equal(archived.status, 0, archived.stderr);
    const archivedPayload = JSON.parse(archived.stdout);
    assert.equal(archivedPayload.ok, true);
    assert.equal(archivedPayload.task.status, 'archived');
    assert.notEqual(archivedPayload.task.status, 'failed');

    const shown = runCli(['task', 'show', task.display_id, '--json'], { cwd: dir, env });
    assert.equal(shown.status, 0, shown.stderr);
    const shownPayload = JSON.parse(shown.stdout);
    assert.equal(shownPayload.status, 'archived');
    assert.equal(shownPayload.metadata.archived_reason, 'duplicate loop-tick left claimed in Do');

    // A real failure must still write 'failed'.
    const real = runCli(['task', 'new', 'Genuine failing task', '--tag', 'archive-test', '--json'], { cwd: dir, env });
    const realTask = JSON.parse(real.stdout).task;
    assert.equal(runCli(['task', 'claim', realTask.display_id, '--as', 'codex'], { cwd: dir, env }).status, 0);
    const failed = runCli(['task', 'done', realTask.display_id, '--failed', '--as', 'codex', '--json'], { cwd: dir, env });
    assert.equal(failed.status, 0, failed.stderr);
    const failedTaskShown = runCli(['task', 'show', realTask.display_id, '--json'], { cwd: dir, env });
    assert.equal(JSON.parse(failedTaskShown.stdout).status, 'failed');
  } finally {
    cleanupTempDir(dir);
  }
});

test('atris task archive refuses without --reason and refuses done/failed tasks', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const env = { ATRIS_TASKS_DB: path.join(dir, 'tasks.db'), NODE_NO_WARNINGS: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const created = runCli(['task', 'new', 'Needs a reason', '--tag', 'archive-test', '--json'], { cwd: dir, env });
    const task = JSON.parse(created.stdout).task;

    const noReason = runCli(['task', 'archive', task.display_id, '--json'], { cwd: dir, env });
    assert.notEqual(noReason.status, 0);

    assert.equal(runCli(['task', 'claim', task.display_id, '--as', 'codex'], { cwd: dir, env }).status, 0);
    assert.equal(runCli(['task', 'done', task.display_id, '--failed', '--as', 'codex'], { cwd: dir, env }).status, 0);
    const archiveFailed = runCli(['task', 'archive', task.display_id, '--reason', 'too late', '--json'], { cwd: dir, env });
    assert.notEqual(archiveFailed.status, 0);
    assert.equal(JSON.parse(archiveFailed.stdout).reason, 'already_failed');
  } finally {
    cleanupTempDir(dir);
  }
});

test('atris task archive --from-failed opts in to failed→archived but never touches done', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const env = { ATRIS_TASKS_DB: path.join(dir, 'tasks.db'), NODE_NO_WARNINGS: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    // failed + --from-failed succeeds and records the prior status.
    const orphan = runCli(['task', 'new', 'Loop tick: duplicate orphan', '--tag', 'archive-test', '--json'], { cwd: dir, env });
    const orphanTask = JSON.parse(orphan.stdout).task;
    assert.equal(runCli(['task', 'claim', orphanTask.display_id, '--as', 'codex'], { cwd: dir, env }).status, 0);
    assert.equal(runCli(['task', 'done', orphanTask.display_id, '--failed', '--as', 'codex'], { cwd: dir, env }).status, 0);

    // Without the flag it still errors (default stays safe).
    const withoutFlag = runCli(['task', 'archive', orphanTask.display_id, '--reason', 'duplicate loop-tick orphan', '--json'], { cwd: dir, env });
    assert.notEqual(withoutFlag.status, 0);
    assert.equal(JSON.parse(withoutFlag.stdout).reason, 'already_failed');

    const withFlag = runCli(['task', 'archive', orphanTask.display_id, '--reason', 'duplicate loop-tick orphan', '--from-failed', '--json'], { cwd: dir, env });
    assert.equal(withFlag.status, 0, withFlag.stderr);
    const payload = JSON.parse(withFlag.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.task.status, 'archived');
    assert.equal(payload.archived_from, 'failed');

    const shown = runCli(['task', 'show', orphanTask.display_id, '--json'], { cwd: dir, env });
    const shownPayload = JSON.parse(shown.stdout);
    assert.equal(shownPayload.status, 'archived');
    assert.equal(shownPayload.metadata.archived_from, 'failed');

    // done + --from-failed still errors: accepted work is never archivable.
    const doneTask = runCli(['task', 'new', 'Genuinely completed work', '--tag', 'archive-test', '--json'], { cwd: dir, env });
    const doneTaskRef = JSON.parse(doneTask.stdout).task;
    assert.equal(runCli(['task', 'claim', doneTaskRef.display_id, '--as', 'codex'], { cwd: dir, env }).status, 0);
    // Simulate a human completion: lift agent proof-only mode for this call
    // (the test process may run inside an agent session with CLAUDECODE set).
    const humanEnv = { ...env, ATRIS_AGENT_PROOF_ONLY: '0' };
    const markedDone = runCli(['task', 'done', doneTaskRef.display_id, '--as', 'codex', '--proof', 'ran node --test test/task-archive-status.test.js; 4/4 pass'], { cwd: dir, env: humanEnv });
    assert.equal(markedDone.status, 0, markedDone.stderr || markedDone.stdout);
    const archiveDone = runCli(['task', 'archive', doneTaskRef.display_id, '--reason', 'should never work', '--from-failed', '--json'], { cwd: dir, env });
    assert.notEqual(archiveDone.status, 0);
    assert.equal(JSON.parse(archiveDone.stdout).reason, 'already_done');
    const stillDone = runCli(['task', 'show', doneTaskRef.display_id, '--json'], { cwd: dir, env });
    assert.equal(JSON.parse(stillDone.stdout).status, 'done');
  } finally {
    cleanupTempDir(dir);
  }
});

test('atris task relabel-archived dry-run finds June-10 backlog-reset rows without writing, --apply relabels them', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const marked = runCli(['task', 'new', 'Certified work swept in the reset', '--tag', 'archive-test', '--json'], { cwd: dir, env });
    const markedTask = JSON.parse(marked.stdout).task;
    assert.equal(runCli(['task', 'claim', markedTask.display_id, '--as', 'codex'], { cwd: dir, env }).status, 0);
    assert.equal(runCli(['task', 'done', markedTask.display_id, '--failed', '--as', 'codex'], { cwd: dir, env }).status, 0);

    const unrelated = runCli(['task', 'new', 'A real unrelated failure', '--tag', 'archive-test', '--json'], { cwd: dir, env });
    const unrelatedTask = JSON.parse(unrelated.stdout).task;
    assert.equal(runCli(['task', 'claim', unrelatedTask.display_id, '--as', 'codex'], { cwd: dir, env }).status, 0);
    assert.equal(runCli(['task', 'done', unrelatedTask.display_id, '--failed', '--as', 'codex'], { cwd: dir, env }).status, 0);

    // Stamp only `marked` with the exact June-10 backlog-reset metadata marker.
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(dbPath);
    const row = db.prepare('SELECT metadata FROM tasks WHERE id = ?').get(markedTask.id);
    const metadata = JSON.parse(row.metadata || '{}');
    metadata.archive_reason = 'First-principles backlog reset 2026-06-10: archived stale bloated tasks not on current roadmap; atris/logs/2026/2026-06-10.md';
    metadata.archived_at = '2026-06-10T06:05:18.736Z';
    metadata.archived_by = 'keshavrao';
    metadata.approval_status = 'archived';
    db.prepare('UPDATE tasks SET metadata = ? WHERE id = ?').run(JSON.stringify(metadata), markedTask.id);
    db.close();

    const dry = runCli(['task', 'relabel-archived', '--dry-run', '--json'], { cwd: dir, env });
    assert.equal(dry.status, 0, dry.stderr);
    const dryPayload = JSON.parse(dry.stdout);
    assert.equal(dryPayload.dry_run, true);
    assert.equal(dryPayload.count, 1);
    assert.equal(dryPayload.sample[0].id, markedTask.id);

    // Dry-run must not have written anything.
    const stillFailed = runCli(['task', 'show', markedTask.display_id, '--json'], { cwd: dir, env });
    assert.equal(JSON.parse(stillFailed.stdout).status, 'failed');

    const apply = runCli(['task', 'relabel-archived', '--apply', '--as', 'test-migrator', '--json'], { cwd: dir, env });
    assert.equal(apply.status, 0, apply.stderr);
    const applyPayload = JSON.parse(apply.stdout);
    assert.equal(applyPayload.dry_run, false);
    assert.equal(applyPayload.count, 1);
    assert.deepEqual(applyPayload.ids, [markedTask.id]);

    const relabeled = runCli(['task', 'show', markedTask.display_id, '--json'], { cwd: dir, env });
    assert.equal(JSON.parse(relabeled.stdout).status, 'archived');

    // The unrelated genuine failure must be untouched.
    const untouched = runCli(['task', 'show', unrelatedTask.display_id, '--json'], { cwd: dir, env });
    assert.equal(JSON.parse(untouched.stdout).status, 'failed');

    // A journal receipt line was written.
    const now = new Date();
    const logName = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}.md`;
    const logPath = path.join(dir, 'atris', 'logs', String(now.getFullYear()), logName);
    assert.ok(fs.existsSync(logPath), 'journal receipt file should exist');
    const logText = fs.readFileSync(logPath, 'utf8');
    assert.match(logText, /Task relabel: failed -> archived \(OBL-1622\)/);
    assert.match(logText, /count: 1/);

    // Re-running dry-run afterward finds nothing left to relabel.
    const dryAgain = runCli(['task', 'relabel-archived', '--dry-run', '--json'], { cwd: dir, env });
    assert.equal(JSON.parse(dryAgain.stdout).count, 0);
  } finally {
    cleanupTempDir(dir);
  }
});
