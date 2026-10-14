'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const taskStore = require('../lib/task-db');
const { closeMergedTasks } = require('../lib/task-close-on-merge');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

function hasNodeSqlite() {
  const result = spawnSync(process.execPath, ['-e', 'require("node:sqlite")'], {
    encoding: 'utf8',
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  });
  return result.status === 0;
}

function makeWorkspace() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-close-merge-')));
  fs.mkdirSync(path.join(root, 'atris'), { recursive: true });
  return root;
}

function waitingJob(db, root, title, member, metadata = {}) {
  return taskStore.addTask(db, {
    title,
    workspaceRoot: root,
    status: 'review',
    claimedBy: member,
    metadata,
  }).id;
}

const LATER = '2099-01-01T00:00:00Z';

// What `gh pr list --state all --json ...` answers for this repo.
function githubAnswer() {
  return [
    { number: 12, state: 'MERGED', mergedAt: LATER, createdAt: LATER, url: 'https://github.com/o/r/pull/12', headRefName: 'codex/builder-login-page-loads-fast-20990101-000000' },
    { number: 13, state: 'CLOSED', mergedAt: null, createdAt: LATER, url: 'https://github.com/o/r/pull/13', headRefName: 'codex/generalist-sign-up-sends-a-welcome-note-20990101-000000' },
    { number: 14, state: 'OPEN', mergedAt: null, createdAt: LATER, url: 'https://github.com/o/r/pull/14', headRefName: 'codex/builder-search-shows-recent-first-20990101-000000' },
    { number: 15, state: 'MERGED', mergedAt: '2000-01-01T00:00:00Z', createdAt: '2000-01-01T00:00:00Z', url: 'https://github.com/o/r/pull/15', headRefName: 'codex/builder-old-title-reused-20000101-000000' },
    { number: 16, state: 'MERGED', mergedAt: LATER, createdAt: LATER, url: 'https://github.com/o/r/pull/16', headRefName: 'feature/exact-branch' },
  ];
}

test('a merged change closes its job and a rejected one reopens it', () => {
  if (!hasNodeSqlite()) return;
  const root = makeWorkspace();
  try {
    const db = taskStore.open(path.join(root, 'tasks.db'));
    const merged = waitingJob(db, root, 'Login page loads fast', 'builder');
    const rejected = waitingJob(db, root, 'Sign up sends a welcome note', 'generalist');
    const stillOpen = waitingJob(db, root, 'Search shows recent first', 'builder');
    const oldTitle = waitingJob(db, root, 'Old title reused', 'builder');
    const noChange = waitingJob(db, root, 'Nobody opened a change yet', 'builder');
    const otherMember = waitingJob(db, root, 'Login page loads fast', 'executor');
    const exact = waitingJob(db, root, 'Branch named by hand', 'builder', { branch: 'feature/exact-branch' });

    const result = closeMergedTasks(db, { workspaceRoot: root, actor: 'tester', lookupPulls: githubAnswer });

    assert.deepEqual(result.closed.map(job => job.id).sort(), [merged, exact].sort());
    assert.deepEqual(result.reopened.map(job => job.id), [rejected]);
    assert.equal(taskStore.getTask(db, merged).status, 'done');
    assert.equal(taskStore.getTask(db, exact).status, 'done');

    const reopenedRow = taskStore.getTask(db, rejected);
    assert.equal(reopenedRow.status, 'open');
    assert.equal(reopenedRow.claimed_by, null);
    assert.match(reopenedRow.metadata.reopen_reason, /closed on GitHub without merging: https:\/\/github\.com\/o\/r\/pull\/13/);
    assert.equal(reopenedRow.metadata.reopened_from, 'review');
    assert.equal(reopenedRow.metadata.approval_status, undefined);

    for (const id of [stillOpen, oldTitle, noChange, otherMember]) {
      assert.equal(taskStore.getTask(db, id).status, 'review');
    }

    const again = closeMergedTasks(db, { workspaceRoot: root, actor: 'tester', lookupPulls: githubAnswer });
    assert.deepEqual(again.closed, []);
    assert.deepEqual(again.reopened, []);
  } finally {
    taskStore.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('when GitHub cannot answer, every job keeps waiting', () => {
  if (!hasNodeSqlite()) return;
  const root = makeWorkspace();
  try {
    const db = taskStore.open(path.join(root, 'tasks.db'));
    const id = waitingJob(db, root, 'Login page loads fast', 'builder');
    const result = closeMergedTasks(db, { workspaceRoot: root, actor: 'tester', lookupPulls: () => null });
    assert.equal(result.skipped, 'github_unavailable');
    assert.equal(taskStore.getTask(db, id).status, 'review');
  } finally {
    taskStore.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('atris task keep asks GitHub and settles waiting jobs', () => {
  if (!hasNodeSqlite()) return;
  const root = makeWorkspace();
  const dbPath = path.join(root, 'tasks.db');
  const fakeBin = path.join(root, 'fake-bin');
  fs.mkdirSync(fakeBin);
  const answerPath = path.join(root, 'answer.json');
  fs.writeFileSync(answerPath, JSON.stringify(githubAnswer()));
  fs.writeFileSync(path.join(fakeBin, 'gh'), `#!/bin/sh\ncat "${answerPath}"\n`, { mode: 0o755 });
  try {
    const db = taskStore.open(dbPath);
    const merged = waitingJob(db, root, 'Login page loads fast', 'builder');
    const rejected = waitingJob(db, root, 'Sign up sends a welcome note', 'generalist');
    taskStore.close();

    const run = spawnSync(process.execPath, [cliPath, 'task', 'keep', '--json'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 30000,
      env: {
        ...process.env,
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
        ATRIS_SKIP_UPDATE_CHECK: '1',
        NODE_NO_WARNINGS: '1',
        ATRIS_TASKS_DB: dbPath,
      },
    });
    assert.equal(run.status, 0, run.stderr);
    const payload = JSON.parse(run.stdout);
    assert.deepEqual(payload.closed_merged.map(job => job.id), [merged]);
    assert.deepEqual(payload.reopened_rejected.map(job => job.id), [rejected]);

    const after = taskStore.open(dbPath);
    assert.equal(taskStore.getTask(after, merged).status, 'done');
    assert.equal(taskStore.getTask(after, rejected).status, 'open');
  } finally {
    taskStore.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
