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

const OLD_DATE = '2020-01-01T00:00:00Z';

function git(root, args, env = {}) {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'tester',
      GIT_AUTHOR_EMAIL: 'tester@example.com',
      GIT_COMMITTER_NAME: 'tester',
      GIT_COMMITTER_EMAIL: 'tester@example.com',
      ...env,
    },
  });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

function commit(root, file, env = {}) {
  fs.writeFileSync(path.join(root, file), `${file}\n`);
  git(root, ['add', file], env);
  git(root, ['commit', '-q', '-m', file], env);
}

// A repo whose base commit is older than any task, so a branch with no
// commits of its own cannot pass for merged work.
function makeRepo() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-close-merge-')));
  fs.mkdirSync(path.join(root, 'atris'), { recursive: true });
  git(root, ['init', '-q', '-b', 'master']);
  commit(root, 'base.txt', { GIT_AUTHOR_DATE: OLD_DATE, GIT_COMMITTER_DATE: OLD_DATE });
  git(root, ['branch', 'fresh']);
  return root;
}

function branchWithCommit(root, branch) {
  git(root, ['checkout', '-q', '-b', branch, 'master']);
  commit(root, `${branch}.txt`);
  git(root, ['checkout', '-q', 'master']);
}

function reviewTask(db, root, title, branch) {
  return taskStore.addTask(db, {
    title,
    workspaceRoot: root,
    status: 'review',
    claimedBy: 'builder',
    metadata: { branch },
  }).id;
}

function cleanup(root) {
  taskStore.close();
  fs.rmSync(root, { recursive: true, force: true });
}

test('a review job closes once its branch merges, and only then', () => {
  if (!hasNodeSqlite()) return;
  const root = makeRepo();
  try {
    const db = taskStore.open(path.join(root, 'tasks.db'));
    const merged = reviewTask(db, root, 'Merged work', 'feature');
    const pending = reviewTask(db, root, 'Still on its branch', 'pending');
    const fresh = reviewTask(db, root, 'Branch with no commits yet', 'fresh');
    const missing = reviewTask(db, root, 'Branch that does not exist', 'ghost');
    branchWithCommit(root, 'feature');
    branchWithCommit(root, 'pending');

    assert.deepEqual(closeMergedTasks(db, { workspaceRoot: root, actor: 'tester' }).closed, []);
    assert.equal(taskStore.getTask(db, merged).status, 'review');

    git(root, ['merge', '-q', '--no-ff', '-m', 'land feature', 'feature']);
    const result = closeMergedTasks(db, { workspaceRoot: root, actor: 'tester' });
    assert.deepEqual(result.closed.map(row => row.id), [merged]);
    assert.equal(result.closed[0].branch, 'feature');
    assert.equal(result.closed[0].base, 'master');
    assert.equal(taskStore.getTask(db, merged).status, 'done');
    for (const id of [pending, fresh, missing]) {
      assert.equal(taskStore.getTask(db, id).status, 'review');
    }

    assert.deepEqual(closeMergedTasks(db, { workspaceRoot: root, actor: 'tester' }).closed, []);
  } finally {
    cleanup(root);
  }
});

test('atris task keep closes merged jobs and says so', () => {
  if (!hasNodeSqlite()) return;
  const root = makeRepo();
  const dbPath = path.join(root, 'tasks.db');
  try {
    const db = taskStore.open(dbPath);
    const merged = reviewTask(db, root, 'Merged work', 'feature');
    const pending = reviewTask(db, root, 'Still on its branch', 'pending');
    branchWithCommit(root, 'feature');
    branchWithCommit(root, 'pending');
    git(root, ['merge', '-q', '--ff-only', 'feature']);
    taskStore.close();

    const run = spawnSync(process.execPath, [cliPath, 'task', 'keep', '--json'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 30000,
      env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1', NODE_NO_WARNINGS: '1', ATRIS_TASKS_DB: dbPath },
    });
    assert.equal(run.status, 0, run.stderr);
    const payload = JSON.parse(run.stdout);
    assert.deepEqual(payload.closed_merged.map(row => row.id), [merged]);
    assert.equal(payload.count, 1);

    const after = taskStore.open(dbPath);
    assert.equal(taskStore.getTask(after, merged).status, 'done');
    assert.equal(taskStore.getTask(after, pending).status, 'review');
  } finally {
    cleanup(root);
  }
});
