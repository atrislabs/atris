'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const taskStore = require('../lib/task-db');
const { CHECK_EVERY_MS, closeMergedTasks, closeMergedTasksIfDue } = require('../lib/task-close-on-merge');
const { DAY_MS, keepTaskList } = require('../lib/task-list-keeper');

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
const ON_MASTER = 'a'.repeat(40);
const OFF_MASTER = 'b'.repeat(40);
const onMaster = commit => commit === ON_MASTER;

function change(number, state, headRefName, extra = {}) {
  const merged = state === 'MERGED';
  return {
    number,
    state,
    baseRefName: 'master',
    headRefName,
    mergedAt: merged ? LATER : null,
    mergeCommit: merged ? { oid: ON_MASTER } : null,
    createdAt: LATER,
    url: `https://github.com/o/r/pull/${number}`,
    ...extra,
  };
}

// What `gh pr list --state all --json ...` answers for this repo.
function githubAnswer() {
  return [
    change(12, 'MERGED', 'codex/builder-login-page-loads-fast-20990101-000000'),
    change(13, 'CLOSED', 'codex/generalist-sign-up-sends-a-welcome-note-20990101-000000'),
    change(14, 'OPEN', 'codex/builder-search-shows-recent-first-20990101-000000'),
    change(15, 'MERGED', 'codex/builder-old-title-reused-20000101-000000', { mergedAt: '2000-01-01T00:00:00Z', createdAt: '2000-01-01T00:00:00Z' }),
    change(16, 'MERGED', 'feature/exact-branch'),
  ];
}

function withDb(fn) {
  if (!hasNodeSqlite()) return;
  const root = makeWorkspace();
  try {
    fn(taskStore.open(path.join(root, 'tasks.db')), root);
  } finally {
    taskStore.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
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

    const result = closeMergedTasks(db, { workspaceRoot: root, actor: 'tester', lookupPulls: githubAnswer, onMaster });

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

    const again = closeMergedTasks(db, { workspaceRoot: root, actor: 'tester', lookupPulls: githubAnswer, onMaster });
    assert.deepEqual(again.closed, []);
    assert.deepEqual(again.reopened, []);
  } finally {
    taskStore.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('jobs held for a human are never closed or reopened', () => withDb((db, root) => {
  const byMetadata = waitingJob(db, root, 'Login page loads fast', 'builder', { tags: ['needs-human'] });
  const byTitle = waitingJob(db, root, 'Sign up sends a welcome note #decision', 'generalist');
  const answer = () => [
    change(12, 'MERGED', 'codex/builder-login-page-loads-fast-20990101-000000'),
    change(13, 'CLOSED', 'codex/generalist-sign-up-sends-a-welcome-note-decision-20990101-000000'),
  ];
  const result = closeMergedTasks(db, { workspaceRoot: root, actor: 'tester', lookupPulls: answer, onMaster });
  assert.deepEqual(result.closed, []);
  assert.deepEqual(result.reopened, []);
  assert.equal(taskStore.getTask(db, byMetadata).status, 'review');
  assert.equal(taskStore.getTask(db, byTitle).status, 'review');
}));

test('a merge counts only when it went into master and its merge commit is on master', () => withDb((db, root) => {
  const otherBase = waitingJob(db, root, 'Login page loads fast', 'builder');
  const offMaster = waitingJob(db, root, 'Search shows recent first', 'builder');
  const noCommit = waitingJob(db, root, 'Old title reused', 'builder');
  const good = waitingJob(db, root, 'Sign up sends a welcome note', 'builder');
  const answer = () => [
    change(12, 'MERGED', 'codex/builder-login-page-loads-fast-20990101-000000', { baseRefName: 'release' }),
    change(14, 'MERGED', 'codex/builder-search-shows-recent-first-20990101-000000', { mergeCommit: { oid: OFF_MASTER } }),
    change(15, 'MERGED', 'codex/builder-old-title-reused-20990101-000000', { mergeCommit: null }),
    change(17, 'MERGED', 'codex/builder-sign-up-sends-a-welcome-note-20990101-000000'),
  ];
  const result = closeMergedTasks(db, { workspaceRoot: root, actor: 'tester', lookupPulls: answer, onMaster });
  assert.deepEqual(result.closed.map(job => job.id), [good]);
  for (const id of [otherBase, offMaster, noCommit]) assert.equal(taskStore.getTask(db, id).status, 'review');
}));

test('one merge closes only the job that owns that branch', () => withDb((db, root) => {
  const first = waitingJob(db, root, 'Login page loads fast', 'builder');
  const twin = waitingJob(db, root, 'Login page loads fast', 'builder');
  const owner = waitingJob(db, root, 'Search shows recent first', 'builder', { branch: 'codex/builder-search-shows-recent-first-20990101-000000' });
  const lookalike = waitingJob(db, root, 'Search shows recent first', 'builder');
  const answer = () => [
    change(12, 'MERGED', 'codex/builder-login-page-loads-fast-20990101-000000'),
    change(14, 'MERGED', 'codex/builder-search-shows-recent-first-20990101-000000'),
  ];
  const result = closeMergedTasks(db, { workspaceRoot: root, actor: 'tester', lookupPulls: answer, onMaster });
  assert.deepEqual(result.closed.map(job => job.id), [owner]);
  for (const id of [first, twin, lookalike]) assert.equal(taskStore.getTask(db, id).status, 'review');
}));

test('GitHub is asked at most every ten minutes unless the landing tick forces it', () => withDb((db, root) => {
  waitingJob(db, root, 'Login page loads fast', 'builder');
  let asked = 0;
  const lookupPulls = () => { asked += 1; return []; };
  const now = Date.now();
  const run = (at, force) => closeMergedTasksIfDue(db, { workspaceRoot: root, actor: 'tester', now: at, force, lookupPulls, onMaster });
  run(now, false);
  assert.equal(asked, 1);
  assert.equal(run(now + CHECK_EVERY_MS - 1, false).skipped, 'not_due');
  assert.equal(asked, 1);
  run(now + 1000, true);
  assert.equal(asked, 2);
  run(now + 1000 + CHECK_EVERY_MS, false);
  assert.equal(asked, 3);
}));

test('old-job cleanup waits until the merge check has seen a waiting job', () => withDb((db, root) => {
  const id = waitingJob(db, root, 'Login page loads fast', 'builder');
  const now = Date.now() + 30 * DAY_MS;
  const neverChecked = keepTaskList(db, { workspaceRoot: root, actor: 'tester', now, missions: [], mergeCheckedAt: null });
  assert.deepEqual(neverChecked.put_away, []);
  const checkedBefore = keepTaskList(db, { workspaceRoot: root, actor: 'tester', now, missions: [], mergeCheckedAt: 1 });
  assert.deepEqual(checkedBefore.put_away, []);
  assert.equal(taskStore.getTask(db, id).status, 'review');
  const checkedAfter = keepTaskList(db, { workspaceRoot: root, actor: 'tester', now, missions: [], mergeCheckedAt: now - DAY_MS });
  assert.deepEqual(checkedAfter.put_away.map(item => item.id), [id]);
}));

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
  const git = (...args) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  git('init', '-q');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'merged change');
  const mergeCommit = git('rev-parse', 'HEAD').stdout.trim();
  git('update-ref', 'refs/remotes/origin/master', mergeCommit);
  const answer = githubAnswer().map(pull => (pull.mergeCommit ? { ...pull, mergeCommit: { oid: mergeCommit } } : pull));
  const answerPath = path.join(root, 'answer.json');
  fs.writeFileSync(answerPath, JSON.stringify(answer));
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
