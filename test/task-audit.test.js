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

function hasNodeSqlite() {
  const result = spawnSync(process.execPath, ['-e', 'require("node:sqlite")'], {
    encoding: 'utf8',
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  });
  return result.status === 0;
}

function makeTempDir() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-task-audit-test-')));
}

function cleanupTempDir(dir) {
  taskStore.close();
  fs.rmSync(dir, { recursive: true, force: true });
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

function addAcceptedTask(db, dir, title, acceptedAt, verify) {
  return taskStore.addTask(db, {
    title,
    tag: 'test',
    workspaceRoot: dir,
    status: 'done',
    metadata: {
      approval_status: 'accepted',
      accepted_at: acceptedAt,
      accepted_by: 'tester',
      ...(verify ? { verify } : {}),
    },
  }).id;
}

test('task audit reports accepted proof health and only revises failures with --revise', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, ATRIS_AGENT_ID: 'codex' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const db = taskStore.open(dbPath);
    const passingId = addAcceptedTask(db, dir, 'Accepted proof still passes', '2026-07-12T03:00:00.000Z', 'true');
    const failingId = addAcceptedTask(db, dir, 'Accepted proof is stale', '2026-07-12T02:00:00.000Z', 'false');
    const skippedId = addAcceptedTask(db, dir, 'Accepted proof has no verifier', '2026-07-12T01:00:00.000Z');
    taskStore.close();

    const report = runCli(['task', 'audit', '--limit', '3', '--json'], { cwd: dir, env });
    assert.equal(report.status, 0, report.stderr);
    const reportPayload = JSON.parse(report.stdout);
    assert.deepEqual(reportPayload.summary, {
      sampled: 3,
      passed: 1,
      failed: 1,
      'skipped-no-verify': 1,
      revised: 0,
    });
    assert.deepEqual(reportPayload.failing_task_ids, [failingId]);
    assert.deepEqual(reportPayload.results.map(row => row.task_id), [passingId, failingId, skippedId]);
    assert.ok(fs.existsSync(path.join(dir, reportPayload.receipt_path)));
    const reportReceipt = JSON.parse(fs.readFileSync(path.join(dir, reportPayload.receipt_path), 'utf8'));
    assert.equal(reportReceipt.schema, 'atris.task_audit_receipt.v1');
    assert.equal(reportReceipt.results.find(row => row.task_id === passingId).verify, 'true');
    assert.equal(reportReceipt.results.find(row => row.task_id === failingId).verify, 'false');
    assert.equal(reportReceipt.results.find(row => row.task_id === skippedId).status, 'skipped-no-verify');

    taskStore.close();
    const reportDb = taskStore.open(dbPath);
    assert.equal(taskStore.getTask(reportDb, passingId).status, 'done');
    assert.equal(taskStore.getTask(reportDb, failingId).status, 'done');
    assert.equal(taskStore.getTask(reportDb, skippedId).status, 'done');
    taskStore.close();

    const revised = runCli(['task', 'audit', '--limit', '3', '--revise', '--json'], { cwd: dir, env });
    assert.equal(revised.status, 0, revised.stderr);
    const revisedPayload = JSON.parse(revised.stdout);
    assert.equal(revisedPayload.summary.revised, 1);

    taskStore.close();
    const revisedDb = taskStore.open(dbPath);
    const passing = taskStore.getTask(revisedDb, passingId);
    const failing = taskStore.getTask(revisedDb, failingId);
    const skipped = taskStore.getTask(revisedDb, skippedId);
    assert.equal(passing.status, 'done');
    assert.equal(passing.metadata.approval_status, 'accepted');
    assert.equal(failing.status, 'open');
    assert.equal(failing.metadata.approval_status, 'revise');
    assert.match(failing.metadata.human_revision_note, new RegExp(revisedPayload.receipt_path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.equal(skipped.status, 'done');
    assert.equal(skipped.metadata.approval_status, 'accepted');
    taskStore.close();

    const text = runCli(['task', 'audit', '--limit', '3'], { cwd: dir, env });
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /task audit: sampled 2, passed 1, failed 0, skipped-no-verify 1/);
    assert.match(text.stdout, /failing task ids: none/);
    assert.match(text.stdout, /receipt: atris\/runs\/task-audit-/);
  } finally {
    cleanupTempDir(dir);
  }
});
