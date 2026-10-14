'use strict';

// A retried job picks up where the last run stopped: when the same member
// reruns the same job, the new checkout starts from the last run's branch if
// that branch still holds work the main line does not have.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createAgentWorktree } = require('../commands/worktree');

function room(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-retry-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'repo');
  fs.mkdirSync(root);
  const git = (args, cwd = root) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout.trim();
  };
  git(['init', '-q', '--initial-branch=main']);
  git(['config', 'user.name', 'test']);
  git(['config', 'user.email', 'test@example.com']);
  fs.writeFileSync(path.join(root, '.gitignore'), '.atris/\n');
  fs.writeFileSync(path.join(root, 'notes.txt'), 'base\n');
  git(['add', '.']);
  git(['commit', '-qm', 'base']);
  const origin = path.join(dir, 'origin.git');
  git(['init', '--bare', '-q', '--initial-branch=main', origin]);
  git(['remote', 'add', 'origin', origin]);
  git(['push', '-q', 'origin', 'main']);
  git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
  return { root, git };
}

function firstRun({ root, git }, task, file, now = new Date('2026-10-14T10:00:00Z')) {
  const first = createAgentWorktree({ root, member: 'builder', task, base: 'origin/main', now });
  fs.writeFileSync(path.join(first.path, file), 'half done\n');
  git(['add', file], first.path);
  git(['commit', '-qm', 'half done'], first.path);
  // The run stops and its checkout is put away; the branch survives.
  git(['worktree', 'remove', '--force', first.path]);
  return first;
}

test('a retry of the same job starts from the work the last run left behind', (t) => {
  const setup = room(t);
  const first = firstRun(setup, 'fix the login page', 'progress.txt');
  const retry = createAgentWorktree({ root: setup.root, member: 'builder', task: 'fix the login page', base: 'origin/main', now: new Date('2026-10-14T11:00:00Z') });
  assert.notEqual(retry.branch, first.branch);
  assert.equal(retry.resumedFrom, first.branch);
  assert.equal(fs.readFileSync(path.join(retry.path, 'progress.txt'), 'utf8'), 'half done\n');
  // It still ships to the main line, not into the old run's branch.
  assert.equal(retry.base, 'origin/main');
  const sidecar = JSON.parse(fs.readFileSync(path.join(retry.path, '.atris', 'agent-worktree.json'), 'utf8'));
  assert.equal(sidecar.resumed_from, first.branch);
});

test('a retry after the last run already landed starts fresh from the main line', (t) => {
  const setup = room(t);
  const first = firstRun(setup, 'fix the login page', 'progress.txt');
  setup.git(['merge', '-q', '--ff-only', first.branch]);
  setup.git(['push', '-q', 'origin', 'main']);
  const retry = createAgentWorktree({ root: setup.root, member: 'builder', task: 'fix the login page', base: 'origin/main', now: new Date('2026-10-14T11:00:00Z') });
  assert.equal(retry.resumedFrom, null);
});

test('a retry never reaches past a newer run that landed to older unfinished work', (t) => {
  const setup = room(t);
  // A newer run of the same job lands; an older run left unfinished work.
  const start = setup.git(['rev-parse', 'main']);
  const landed = firstRun(setup, 'fix login', 'progress.txt', new Date('2026-10-14T11:00:00Z'));
  setup.git(['merge', '-q', '--no-ff', '-m', 'land', landed.branch]);
  setup.git(['push', '-q', 'origin', 'main']);
  const old = path.join(path.dirname(setup.root), 'old-run');
  setup.git(['worktree', 'add', '-q', '-b', 'codex/builder-fix-login-20261014-100000', old, start]);
  fs.writeFileSync(path.join(old, 'stale.txt'), 'stale\n');
  setup.git(['add', 'stale.txt'], old);
  setup.git(['commit', '-qm', 'stale'], old);
  setup.git(['worktree', 'remove', '--force', old]);
  const retry = createAgentWorktree({ root: setup.root, member: 'builder', task: 'fix login', base: 'origin/main', now: new Date('2026-10-14T12:00:00Z') });
  assert.equal(retry.resumedFrom, null);
  assert.equal(fs.existsSync(path.join(retry.path, 'stale.txt')), false);
});

test('a different job never inherits another job\'s unfinished work', (t) => {
  const setup = room(t);
  firstRun(setup, 'fix the login page', 'progress.txt');
  const other = createAgentWorktree({ root: setup.root, member: 'builder', task: 'fix the signup page', base: 'origin/main', now: new Date('2026-10-14T11:00:00Z') });
  assert.equal(other.resumedFrom, null);
  assert.equal(fs.existsSync(path.join(other.path, 'progress.txt')), false);
  // Same job name, different member: also a different job.
  const stranger = createAgentWorktree({ root: setup.root, member: 'reviewer', task: 'fix the login page', base: 'origin/main', now: new Date('2026-10-14T11:00:01Z') });
  assert.equal(stranger.resumedFrom, null);
});
