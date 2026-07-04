'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');
let taskDb;

function hasNodeSqlite() {
  const result = spawnSync(process.execPath, ['-e', 'require("node:sqlite")'], {
    encoding: 'utf8',
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  });
  return result.status === 0;
}

function hasGit() {
  return spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;
}

function taskStore() {
  if (!taskDb) taskDb = require('../lib/task-db');
  return taskDb;
}

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-truth-test-'));
}

function cleanupTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function runGit(args, { cwd }) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}

function runCli(args, { cwd, env } = {}) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 20000,
    env: {
      ...process.env,
      ATRIS_SKIP_UPDATE_CHECK: '1',
      NODE_NO_WARNINGS: '1',
      ...(env || {}),
    },
  });
  if (result.error) throw result.error;
  return result;
}

function seedTask(db, workspaceRoot, title, options = {}) {
  const store = taskStore();
  store.addTask(db, {
    title,
    workspaceRoot,
    status: options.status || 'open',
    claimedBy: options.claimedBy,
    tag: 'truth-test',
  });
}

test('truth defaults task counts to the current workspace and --all keeps the global view', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const store = taskStore();
  const current = path.join(dir, 'current');
  const other = path.join(dir, 'other');
  const home = path.join(dir, 'home');
  const dbPath = path.join(dir, 'tasks.db');

  try {
    fs.mkdirSync(path.join(current, 'atris'), { recursive: true });
    fs.mkdirSync(path.join(other, 'atris'), { recursive: true });
    fs.mkdirSync(home, { recursive: true });

    const currentRoot = store.workspaceRoot(current);
    const otherRoot = store.workspaceRoot(other);
    const db = store.open(dbPath);
    seedTask(db, currentRoot, 'Current open task one');
    seedTask(db, currentRoot, 'Current open task two');
    seedTask(db, currentRoot, 'Current claimed task', { status: 'claimed', claimedBy: 'codex' });
    for (let i = 0; i < 7; i += 1) {
      seedTask(db, otherRoot, `Other workspace task ${i + 1}`);
    }
    store.close();

    const env = { ATRIS_TASKS_DB: dbPath, HOME: home };
    const scoped = runCli(['truth', '--json'], { cwd: current, env });
    assert.equal(scoped.status, 0, scoped.stderr);
    const scopedPayload = JSON.parse(scoped.stdout);
    assert.equal(scopedPayload.scope.kind, 'workspace');
    assert.equal(scopedPayload.scope.workspace_root, currentRoot);
    assert.deepEqual(scopedPayload.tasks, { claimed: 1, open: 2 });

    const scopedText = runCli(['truth'], { cwd: current, env });
    assert.equal(scopedText.status, 0, scopedText.stderr);
    assert.match(scopedText.stdout, new RegExp(`Scope: workspace \\(${currentRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)`));
    assert.match(scopedText.stdout, /2 open/);
    assert.doesNotMatch(scopedText.stdout, /9 open/);

    const global = runCli(['truth', '--all', '--json'], { cwd: current, env });
    assert.equal(global.status, 0, global.stderr);
    const globalPayload = JSON.parse(global.stdout);
    assert.equal(globalPayload.scope.kind, 'global');
    assert.deepEqual(globalPayload.tasks, { claimed: 1, open: 9 });

    const globalText = runCli(['truth', '--all'], { cwd: current, env });
    assert.equal(globalText.status, 0, globalText.stderr);
    assert.match(globalText.stdout, /Scope: global/);
    assert.match(globalText.stdout, /9 open/);
  } finally {
    store.close();
    cleanupTempDir(dir);
  }
});

test('truth resolves isolated git worktrees to the shared task workspace', () => {
  if (!hasNodeSqlite() || !hasGit()) return;
  const dir = makeTempDir();
  const store = taskStore();
  const base = path.join(dir, 'atris-cli');
  const worktree = path.join(dir, 'codex-worktree');
  const other = path.join(dir, 'other');
  const home = path.join(dir, 'home');
  const dbPath = path.join(dir, 'tasks.db');

  try {
    fs.mkdirSync(path.join(base, 'atris'), { recursive: true });
    fs.mkdirSync(path.join(other, 'atris'), { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(base, 'README.md'), '# fixture\n', 'utf8');
    fs.writeFileSync(path.join(base, 'atris', 'README.md'), '# atris\n', 'utf8');
    runGit(['init'], { cwd: base });
    runGit(['add', '.'], { cwd: base });
    runGit(['-c', 'user.email=test@example.com', '-c', 'user.name=Test User', 'commit', '-m', 'init'], { cwd: base });
    runGit(['worktree', 'add', '--detach', worktree, 'HEAD'], { cwd: base });

    const baseRoot = store.workspaceRoot(base);
    const otherRoot = store.workspaceRoot(other);
    const db = store.open(dbPath);
    seedTask(db, baseRoot, 'Canonical repo open task');
    for (let i = 0; i < 4; i += 1) {
      seedTask(db, otherRoot, `Other workspace task ${i + 1}`);
    }
    store.close();

    const env = { ATRIS_TASKS_DB: dbPath, HOME: home };
    const scoped = runCli(['truth', '--json'], { cwd: worktree, env });
    assert.equal(scoped.status, 0, scoped.stderr);
    const payload = JSON.parse(scoped.stdout);
    assert.equal(payload.scope.kind, 'workspace');
    assert.equal(payload.scope.workspace_root, baseRoot);
    assert.deepEqual(payload.tasks, { open: 1 });

    const global = runCli(['truth', '--all', '--json'], { cwd: worktree, env });
    assert.equal(global.status, 0, global.stderr);
    assert.deepEqual(JSON.parse(global.stdout).tasks, { open: 5 });
  } finally {
    store.close();
    cleanupTempDir(dir);
  }
});

test('truth splits unproven features into live lanes and parked idea packets', () => {
  if (!hasNodeSqlite() || !hasGit()) return;
  const dir = makeTempDir();
  const home = path.join(dir, 'home');
  const repo = path.join(dir, 'repo');
  try {
    fs.mkdirSync(home, { recursive: true });
    const featureDir = (name) => path.join(repo, 'atris', 'features', name);
    for (const name of ['live-lane', 'old-idea']) {
      fs.mkdirSync(featureDir(name), { recursive: true });
      fs.writeFileSync(path.join(featureDir(name), 'validate.md'), 'status: packet-created\n', 'utf8');
    }
    runGit(['init'], { cwd: repo });
    const commit = (msg, when) => {
      runGit(['add', '.'], { cwd: repo });
      const result = spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=T', 'commit', '-m', msg], {
        cwd: repo,
        encoding: 'utf8',
        env: { ...process.env, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when },
      });
      assert.equal(result.status, 0, result.stderr);
    };
    // both features born 60 days ago; only live-lane edited since
    const old = new Date(Date.now() - 60 * 86400000).toISOString();
    commit('seed features', old);
    fs.appendFileSync(path.join(featureDir('live-lane'), 'validate.md'), 'notes: in flight\n');
    commit('work on live lane', new Date().toISOString());

    const result = runCli(['truth', '--json'], { cwd: repo, env: { HOME: home, ATRIS_TASKS_DB: path.join(dir, 'tasks.db') } });
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    const byLane = Object.fromEntries(payload.feature_rows.map((f) => [f.lane, f.verdict]));
    assert.equal(byLane['live-lane'], 'unproven');
    assert.equal(byLane['old-idea'], 'parked');
    assert.deepEqual(payload.features, { unproven: 1, parked: 1 });
  } finally {
    cleanupTempDir(dir);
  }
});
