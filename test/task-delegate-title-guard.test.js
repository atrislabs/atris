'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const taskDb = require('../lib/task-db');

const REPO_ROOT = path.resolve(__dirname, '..');

function tempWorkspace() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-delegate-guard-')));
  fs.mkdirSync(path.join(root, 'atris'), { recursive: true });
  fs.mkdirSync(path.join(root, '.atris', 'state'), { recursive: true });
  return root;
}

function cleanup(root) {
  taskDb.close();
  fs.rmSync(root, { recursive: true, force: true });
}

function runTaskCli(root, dbPath, args) {
  taskDb.close();
  return spawnSync(process.execPath, [path.join(REPO_ROOT, 'bin', 'atris.js'), 'task', ...args], {
    cwd: root,
    env: {
      ...process.env,
      ATRIS_TASKS_DB: dbPath,
      ATRIS_SKIP_UPDATE_CHECK: '1',
      NODE_NO_WARNINGS: '1',
    },
    encoding: 'utf8',
  });
}

function listTasks(root, dbPath) {
  const res = runTaskCli(root, dbPath, ['list', '--json']);
  assert.equal(res.status, 0, res.stderr);
  const parsed = JSON.parse(res.stdout);
  return parsed.tasks || parsed;
}

test('delegate with a bare ref title rewrites to the parent title and inherits verify', () => {
  const root = tempWorkspace();
  const dbPath = path.join(root, '.atris', 'state', 'tasks.db');
  try {
    const parent = runTaskCli(root, dbPath, ['new', 'fix login redirect loop', '--verify', 'node test/login.test.js', '--json']);
    assert.equal(parent.status, 0, parent.stderr);
    const tasks = listTasks(root, dbPath);
    const parentRef = tasks[0].display_id;
    assert.match(parentRef, /^[A-Z][A-Z0-9]*-[0-9]+$/);

    const res = runTaskCli(root, dbPath, ['delegate', parentRef, '--to', 'executor', '--json']);
    assert.equal(res.status, 0, res.stderr);
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.task.title, 'Follow-up on fix login redirect loop');
    assert.equal(payload.task.metadata && payload.task.metadata.verify, 'node test/login.test.js');
  } finally {
    cleanup(root);
  }
});

test('delegate with a bare ref that does not resolve fails with a plain error', () => {
  const root = tempWorkspace();
  const dbPath = path.join(root, '.atris', 'state', 'tasks.db');
  try {
    const res = runTaskCli(root, dbPath, ['delegate', 'ZZZ-9999', '--to', 'executor', '--json']);
    assert.notEqual(res.status, 0);
    assert.match(res.stderr + res.stdout, /real words|task ref/i);
  } finally {
    cleanup(root);
  }
});

test('delegate with a normal title passes through untouched', () => {
  const root = tempWorkspace();
  const dbPath = path.join(root, '.atris', 'state', 'tasks.db');
  try {
    const res = runTaskCli(root, dbPath, ['delegate', 'tighten retry backoff on sync', '--to', 'executor', '--json']);
    assert.equal(res.status, 0, res.stderr);
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.task.title, 'tighten retry backoff on sync');
  } finally {
    cleanup(root);
  }
});
