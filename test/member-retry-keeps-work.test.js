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

test('a retry starts fresh when the last run no longer merges cleanly with the main line', (t) => {
  const setup = room(t);
  const first = firstRun(setup, 'fix the login page', 'notes.txt');
  // The main line changes the same line the last run changed.
  fs.writeFileSync(path.join(setup.root, 'notes.txt'), 'someone else\n');
  setup.git(['commit', '-qam', 'main moves on']);
  setup.git(['push', '-q', 'origin', 'main']);
  const retry = createAgentWorktree({ root: setup.root, member: 'builder', task: 'fix the login page', base: 'origin/main', now: new Date('2026-10-14T11:00:00Z') });
  assert.equal(retry.resumedFrom, null);
  assert.equal(retry.skippedResume, first.branch);
  assert.equal(fs.readFileSync(path.join(retry.path, 'notes.txt'), 'utf8'), 'someone else\n');
  const sidecar = JSON.parse(fs.readFileSync(path.join(retry.path, '.atris', 'agent-worktree.json'), 'utf8'));
  assert.equal(sidecar.skipped_resume, first.branch);
  // The old run's commits are still on its branch.
  assert.equal(setup.git(['show', `${first.branch}:notes.txt`]), 'half done');
});

test('a retry still resumes when the main line moved without touching the same lines', (t) => {
  const setup = room(t);
  const first = firstRun(setup, 'fix the login page', 'progress.txt');
  fs.writeFileSync(path.join(setup.root, 'other.txt'), 'unrelated\n');
  setup.git(['add', 'other.txt']);
  setup.git(['commit', '-qm', 'main moves on']);
  setup.git(['push', '-q', 'origin', 'main']);
  const retry = createAgentWorktree({ root: setup.root, member: 'builder', task: 'fix the login page', base: 'origin/main', now: new Date('2026-10-14T11:00:00Z') });
  assert.equal(retry.resumedFrom, first.branch);
  assert.equal(retry.skippedResume, null);
});

test('a resumed retry also starts with everything the main line gained since', (t) => {
  // 2026-10-15: five long jobs kept resuming their own last branch and fell
  // 103 to 129 commits behind the main line until every one clashed.
  const setup = room(t);
  const first = firstRun(setup, 'fix the login page', 'progress.txt');
  fs.writeFileSync(path.join(setup.root, 'other.txt'), 'unrelated\n');
  setup.git(['add', 'other.txt']);
  setup.git(['commit', '-qm', 'main moves on']);
  setup.git(['push', '-q', 'origin', 'main']);
  const retry = createAgentWorktree({ root: setup.root, member: 'builder', task: 'fix the login page', base: 'origin/main', now: new Date('2026-10-14T11:00:00Z') });
  assert.equal(retry.resumedFrom, first.branch);
  assert.equal(fs.readFileSync(path.join(retry.path, 'progress.txt'), 'utf8'), 'half done\n');
  assert.equal(fs.readFileSync(path.join(retry.path, 'other.txt'), 'utf8'), 'unrelated\n');
  assert.equal(setup.git(['rev-list', '--count', 'HEAD..origin/main'], retry.path), '0');
});

// Flights used to name a job by the display id a person reads (dispatch-feed-12) and now name it by
// the row id (dispatch-01k8...). The older name is not an identity: display names repeat across
// workspaces and change when the task list changes, so a branch under one can belong to another job.
// A retry that is told the older name never starts from such a branch. It only says where unfinished
// work under that name may be, in one line, and the run starts from the job's own name.
const OLD_NAME = 'dispatch-feed-12';
const NEW_NAME = 'dispatch-01k8x3m2q4abcdefghjkmnpqrs';
const retryAt = (setup, task, formerTasks, now = new Date('2026-10-14T12:00:00Z')) => createAgentWorktree({
  root: setup.root, member: 'builder', task, base: 'origin/main', now, ...(formerTasks ? { formerTasks } : {}),
});
// What the start printed to stderr, as lines, from now on.
function stderrLines(t) {
  const lines = [];
  t.mock.method(console, 'error', (...parts) => { lines.push(parts.join(' ')); });
  return lines;
}
const aboutOlderWork = (lines) => lines.filter((line) => /older unfinished work/.test(line));

test('a retry under a job\'s new name never starts from the unfinished run its older name left behind, and says where that run is', (t) => {
  const told = room(t);
  const older = firstRun(told, OLD_NAME, 'progress.txt');
  const said = stderrLines(t);

  const retry = retryAt(told, NEW_NAME, [OLD_NAME]);

  assert.equal(retry.resumedFrom, null);
  assert.equal(fs.existsSync(path.join(retry.path, 'progress.txt')), false, 'a display name is not an identity, so the work under it is not the starting point');
  assert.match(retry.branch, new RegExp(`^codex/builder-${NEW_NAME}-\\d{8}-\\d{6}$`), 'the new run is named for the new name');
  const sidecar = JSON.parse(fs.readFileSync(path.join(retry.path, '.atris', 'agent-worktree.json'), 'utf8'));
  assert.equal(sidecar.resumed_from, null);
  assert.deepEqual(aboutOlderWork(said), [`note: older unfinished work may be on ${older.branch}; starting fresh`]);
  assert.equal(told.git(['show', `${older.branch}:progress.txt`]), 'half done', 'the older branch keeps its commits');

  // Told no older name, it has nothing to say and does the same.
  const untold = room(t);
  firstRun(untold, OLD_NAME, 'progress.txt');
  said.length = 0;
  const fresh = retryAt(untold, NEW_NAME);
  assert.equal(fresh.resumedFrom, null);
  assert.equal(fs.existsSync(path.join(fresh.path, 'progress.txt')), false);
  assert.deepEqual(aboutOlderWork(said), []);
});

test('a retry still continues from the run under the job\'s own name, whichever run is newer, and says the older name has unfinished work too', (t) => {
  const said = stderrLines(t);
  for (const [label, ownAt, olderAt] of [
    ['the older name\'s run is older', '2026-10-14T11:00:00Z', '2026-10-14T10:00:00Z'],
    ['the older name\'s run is newer', '2026-10-14T10:00:00Z', '2026-10-14T11:00:00Z'],
  ]) {
    const setup = room(t);
    const older = firstRun(setup, OLD_NAME, 'old.txt', new Date(olderAt));
    const own = firstRun(setup, NEW_NAME, 'new.txt', new Date(ownAt));
    said.length = 0;

    const retry = retryAt(setup, NEW_NAME, [OLD_NAME]);

    assert.equal(retry.resumedFrom, own.branch, label);
    assert.equal(fs.existsSync(path.join(retry.path, 'new.txt')), true, label);
    assert.equal(fs.existsSync(path.join(retry.path, 'old.txt')), false, label);
    assert.deepEqual(aboutOlderWork(said), [`note: older unfinished work may be on ${older.branch}; continuing from ${own.branch} instead`], label);
  }
});

test('only that member\'s unfinished runs under exactly the older name are mentioned: not another job that starts with it, not another member\'s run, not one that already landed', (t) => {
  const setup = room(t);
  firstRun(setup, 'dispatch-feed-120', 'other-job.txt', new Date('2026-10-14T10:00:00Z'));
  const stranger = createAgentWorktree({ root: setup.root, member: 'reviewer', task: OLD_NAME, base: 'origin/main', now: new Date('2026-10-14T10:30:00Z') });
  fs.writeFileSync(path.join(stranger.path, 'stranger.txt'), 'not yours\n');
  setup.git(['add', 'stranger.txt'], stranger.path);
  setup.git(['commit', '-qm', 'stranger'], stranger.path);
  setup.git(['worktree', 'remove', '--force', stranger.path]);
  const said = stderrLines(t);

  const retry = retryAt(setup, NEW_NAME, [OLD_NAME, '', null]);

  assert.equal(retry.resumedFrom, null);
  assert.equal(fs.existsSync(path.join(retry.path, 'other-job.txt')), false);
  assert.equal(fs.existsSync(path.join(retry.path, 'stranger.txt')), false);
  assert.deepEqual(aboutOlderWork(said), []);

  // A run under the older name that already landed has no unfinished work to point at.
  const landed = room(t);
  const done = firstRun(landed, OLD_NAME, 'progress.txt');
  landed.git(['merge', '-q', '--ff-only', done.branch]);
  landed.git(['push', '-q', 'origin', 'main']);
  const after = retryAt(landed, NEW_NAME, [OLD_NAME]);
  assert.equal(after.resumedFrom, null);
  assert.deepEqual(aboutOlderWork(said), []);
});

test('the job\'s own name given as its older name says nothing: its own unfinished run is simply continued', (t) => {
  const setup = room(t);
  const own = firstRun(setup, NEW_NAME, 'new.txt');
  const said = stderrLines(t);

  const retry = retryAt(setup, NEW_NAME, [NEW_NAME, ` ${NEW_NAME.toUpperCase()} `]);

  assert.equal(retry.resumedFrom, own.branch);
  assert.deepEqual(aboutOlderWork(said), []);
});

test('a blank older name means no older name: it is not read as a job called "task"', (t) => {
  const setup = room(t);
  // A blank name is slugged to the fallback "task", so a run of a job actually called that is the
  // one a careless blank would pick up.
  firstRun(setup, 'task', 'someone-elses.txt', new Date('2026-10-14T10:00:00Z'));
  const said = stderrLines(t);

  const retry = retryAt(setup, NEW_NAME, ['', '   ', null, undefined]);

  assert.equal(retry.resumedFrom, null);
  assert.equal(fs.existsSync(path.join(retry.path, 'someone-elses.txt')), false);
  assert.deepEqual(aboutOlderWork(said), []);
});
