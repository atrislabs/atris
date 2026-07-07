'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { withTaskReadyResult } = require('./helpers/task-result');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');
const taskStore = require('../lib/task-db');

function hasNodeSqlite() {
  const result = spawnSync(process.execPath, ['-e', 'require("node:sqlite")'], {
    encoding: 'utf8',
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  });
  return result.status === 0;
}

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-task-review-autoaccept-test-'));
}

function cleanupTempDir(dir) {
  taskStore.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

function runCli(args, { cwd, env } = {}) {
  const result = spawnSync(process.execPath, [cliPath, ...withTaskReadyResult(args)], {
    cwd,
    encoding: 'utf8',
    timeout: 30000,
    env: {
      ...process.env,
      ATRIS_SKIP_UPDATE_CHECK: '1',
      ...(env || {}),
    },
  });
  if (result.error) throw result.error;
  return result;
}

function initWorkspace(dir) {
  fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'test'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'test', 'pass.test.js'), `
    const test = require('node:test');
    const assert = require('node:assert/strict');
    test('pass', () => assert.equal(1, 1));
  `, 'utf8');
}

function patchMetadata(dbPath, taskId, patch) {
  taskStore.close();
  const db = taskStore.open(dbPath);
  try {
    const row = taskStore.getTask(db, taskId);
    assert.ok(row, `missing task ${taskId}`);
    const metadata = { ...(row.metadata || {}), ...patch };
    db.prepare('UPDATE tasks SET metadata = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(metadata), Date.now(), taskId);
  } finally {
    taskStore.close();
  }
}

function showTask(dir, env, ref) {
  const shown = runCli(['task', 'show', ref, '--json'], { cwd: dir, env });
  assert.equal(shown.status, 0, shown.stderr);
  return JSON.parse(shown.stdout);
}

function certifyTask(dir, env, dbPath, {
  title,
  tag = 'review',
  diffStats,
  metadata = {},
}) {
  const created = runCli(['task', 'new', title, '--tag', tag, '--json'], { cwd: dir, env });
  assert.equal(created.status, 0, created.stderr);
  const task = JSON.parse(created.stdout).task;
  const ref = task.display_id;
  assert.equal(runCli(['task', 'claim', ref, '--as', 'codex'], { cwd: dir, env }).status, 0);
  const ready = runCli([
    'task', 'ready', ref,
    '--verify', 'node --test test/pass.test.js',
    '--as', 'codex',
  ], { cwd: dir, env });
  assert.equal(ready.status, 0, ready.stderr);
  patchMetadata(dbPath, task.id, {
    diff_stats: diffStats,
    ...metadata,
  });
  const review = runCli([
    'task', 'review', ref,
    '--reward', '0',
    '--as', 'validator',
    '--proof', 'Second actor re-ran node --test test/pass.test.js and it passed. The diff proof was inspected.',
    '--verify', 'node --test test/pass.test.js',
  ], { cwd: dir, env });
  assert.equal(review.status, 0, review.stderr);
  return task;
}

test('review auto-accepts small certified work and leaves big file-count work queued', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_AGENT_PROOF_ONLY: '0' };
  try {
    initWorkspace(dir);
    const small = certifyTask(dir, env, dbPath, {
      title: 'Ship small certified review flow',
      diffStats: {
        files_touched: 2,
        changed_lines: 24,
        files: ['src/review.js', 'test/review.test.js'],
      },
    });
    const big = certifyTask(dir, env, dbPath, {
      title: 'Ship larger certified review flow',
      diffStats: {
        files_touched: 11,
        changed_lines: 40,
        files: Array.from({ length: 11 }, (_, index) => `src/file-${index}.js`),
      },
    });

    const review = runCli(['review'], { cwd: dir, env });
    assert.equal(review.status, 0, review.stderr);
    assert.match(review.stdout, /1 reviews auto-accepted since your last look/);
    assert.match(review.stdout, new RegExp(`approve: atris task accept ${big.display_id}`));
    assert.doesNotMatch(review.stdout, new RegExp(`approve: atris task accept ${small.display_id}`));

    const accepted = showTask(dir, env, small.display_id);
    assert.equal(accepted.status, 'done');
    assert.equal(accepted.metadata.accepted_by, 'auto (certified, small)');
    assert.equal(accepted.metadata.auto_accepted_by, 'auto (certified, small)');
    assert.equal(accepted.metadata.auto_accept_policy, 'review_autoaccept_certified_small');
    assert.match(accepted.metadata.accepted_at, /^\d{4}-\d{2}-\d{2}T/);

    const queued = showTask(dir, env, big.display_id);
    assert.equal(queued.status, 'review');
    assert.equal(queued.review.approval_status, 'pending');
  } finally {
    cleanupTempDir(dir);
  }
});

test('review keeps daily update style certified work queued even when it is small', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_AGENT_PROOF_ONLY: '0' };
  try {
    initWorkspace(dir);
    const task = certifyTask(dir, env, dbPath, {
      title: 'Daily update for the operator',
      diffStats: { files_touched: 1, changed_lines: 12, files: ['reports/daily.md'] },
    });

    const review = runCli(['review'], { cwd: dir, env });
    assert.equal(review.status, 0, review.stderr);
    assert.doesNotMatch(review.stdout, /reviews auto-accepted since your last look/);
    assert.match(review.stdout, new RegExp(`approve: atris task accept ${task.display_id}`));
    assert.equal(showTask(dir, env, task.display_id).status, 'review');
  } finally {
    cleanupTempDir(dir);
  }
});

test('review keeps protected tiny auth work queued', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_AGENT_PROOF_ONLY: '0' };
  try {
    initWorkspace(dir);
    const task = certifyTask(dir, env, dbPath, {
      title: 'Tighten login copy',
      diffStats: { files_touched: 1, changed_lines: 8, files: ['src/auth/login.js'] },
    });

    const review = runCli(['review'], { cwd: dir, env });
    assert.equal(review.status, 0, review.stderr);
    assert.match(review.stdout, new RegExp(`approve: atris task accept ${task.display_id}`));
    assert.equal(showTask(dir, env, task.display_id).status, 'review');
  } finally {
    cleanupTempDir(dir);
  }
});

test('review autoaccept config off restores the human approval queue', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_AGENT_PROOF_ONLY: '0' };
  try {
    initWorkspace(dir);
    fs.writeFileSync(path.join(dir, 'atris', '.config'), JSON.stringify({ autoaccept: false }, null, 2) + '\n', 'utf8');
    const task = certifyTask(dir, env, dbPath, {
      title: 'Ship small certified review with knob off',
      diffStats: { files_touched: 1, changed_lines: 10, files: ['src/review.js'] },
    });

    const review = runCli(['review'], { cwd: dir, env });
    assert.equal(review.status, 0, review.stderr);
    assert.doesNotMatch(review.stdout, /reviews auto-accepted since your last look/);
    assert.match(review.stdout, new RegExp(`approve: atris task accept ${task.display_id}`));
    assert.equal(showTask(dir, env, task.display_id).status, 'review');
  } finally {
    cleanupTempDir(dir);
  }
});
