'use strict';

// The cleaner removes finished copies however they landed, saves long-idle work
// before removing it, and never touches a copy a running program is using.
// Every copy here is a real git worktree. GitHub is a fake `gh` on the PATH.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { cleanupWorktrees, sweepWorkspace, worktreeCommand } = require('../commands/worktree');

const HOUR_MS = 60 * 60 * 1000;
const DAY_HOURS = 24;

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return String(result.stdout || '').trim();
}

function backdate(target, hours) {
  const stamp = new Date(Date.now() - hours * HOUR_MS);
  fs.utimesSync(target, stamp, stamp);
}

function backdateCopy(copy, hours) {
  const gitDir = git(copy, ['rev-parse', '--absolute-git-dir']);
  for (const mark of [copy, path.join(gitDir, 'HEAD'), path.join(gitDir, 'logs', 'HEAD')]) {
    if (fs.existsSync(mark)) backdate(mark, hours);
  }
}

function lockCopy(copy, hours, reason = 'someone was here') {
  git(copy, ['worktree', 'lock', '--reason', reason, copy]);
  backdate(path.join(git(copy, ['rev-parse', '--absolute-git-dir']), 'locked'), hours);
}

function setup(t) {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-finished-copies-')));
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  const root = path.join(ws, 'app');
  fs.mkdirSync(root);
  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 'test@example.com']);
  git(root, ['config', 'user.name', 'Test User']);
  fs.writeFileSync(path.join(root, '.gitignore'), ['node_modules/', '.next/', 'dist/', 'build/', 'venv/', '.venv/', '__pycache__/', '.turbo/', '.cache/', 'coverage/', '.env', 'data/', ''].join('\n'));
  fs.writeFileSync(path.join(root, 'README.md'), 'hello\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'init']);
  git(root, ['branch', '-M', 'master']);
  const remote = path.join(ws, 'app-origin.git');
  git(ws, ['init', '--bare', '-q', remote]);
  git(root, ['remote', 'add', 'origin', remote]);
  git(root, ['push', '-q', '-u', 'origin', 'master']);
  git(root, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/master']);
  return { ws, root, rescueRoot: path.join(ws, 'rescue'), base: 'origin/master' };
}

function addCopy(context, name, { hoursOld = 3, commit = false, at } = {}) {
  const copy = at || path.join(context.ws, 'app-worktrees', name);
  fs.mkdirSync(path.dirname(copy), { recursive: true });
  git(context.root, ['worktree', 'add', '-q', '-b', `work/${name}`, copy, 'origin/master']);
  if (commit) commitIn(copy, `${name}.txt`, `${name}\n`);
  backdateCopy(copy, hoursOld);
  return copy;
}

function commitIn(copy, file, body) {
  fs.writeFileSync(path.join(copy, file), body);
  git(copy, ['add', file]);
  git(copy, ['commit', '-qm', `change ${file}`]);
  return git(copy, ['rev-parse', 'HEAD']);
}

// Lands content on origin/master under a new commit id, the way a squash or rebase merge does.
function landOnMaster(context, file, body) {
  fs.writeFileSync(path.join(context.root, file), body);
  git(context.root, ['add', file]);
  git(context.root, ['commit', '-qm', `land ${file}`]);
  git(context.root, ['push', '-q', 'origin', 'master']);
}

// A `gh` that answers from a script and writes each call to a log.
function fakeGh(t, script) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-fake-gh-'));
  const log = path.join(bin, 'calls.log');
  const answer = (body) => fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\necho "$*" >> "${log}"\n${body}\n`, { mode: 0o755 });
  answer(script);
  const previous = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${previous}`;
  t.after(() => {
    process.env.PATH = previous;
    fs.rmSync(bin, { recursive: true, force: true });
  });
  return { answer, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : []) };
}

function run(context, options = {}) {
  return cleanupWorktrees({ root: context.root, base: context.base, activeCwds: [], rescueRoot: context.rescueRoot, ...options });
}

function keptReason(result, copy) {
  const row = result.kept.find((item) => item.path === copy);
  return row && row.reason;
}

function branchExists(root, branch) {
  return spawnSync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: root }).status === 0;
}

function onlyRescue(context) {
  const days = fs.readdirSync(context.rescueRoot);
  assert.equal(days.length, 1);
  const names = fs.readdirSync(path.join(context.rescueRoot, days[0]));
  assert.equal(names.length, 1, names.join(','));
  return path.join(context.rescueRoot, days[0], names[0]);
}

function modeOf(target) {
  return (fs.statSync(target).mode & 0o777).toString(8);
}

// How a copy counts as finished.

test('a squash-merged branch is finished when a merged pull request carries its exact head', (t) => {
  const context = setup(t);
  const copy = addCopy(context, 'squashed', { commit: true });
  const head = git(copy, ['rev-parse', 'HEAD']);
  backdateCopy(copy, 3);
  landOnMaster(context, 'squashed.txt', 'squashed and reworded\n');
  const gh = fakeGh(t, `echo '[{"number":77,"headRefOid":"${head}","baseRefName":"master"}]'`);

  const result = run(context, { apply: true });
  assert.deepEqual(result.removed.map((item) => [item.path, item.reason, item.pull_request]), [[copy, 'merged_pr', 77]]);
  assert.equal(fs.existsSync(copy), false);
  assert.equal(branchExists(context.root, 'work/squashed'), true, 'the branch survives');
  assert.equal(fs.existsSync(context.rescueRoot), false, 'a finished clean copy has nothing to save');
  assert.match(gh.calls()[0], /^pr list --state merged --head work\/squashed /);
});

test('a merged pull request does not vouch for work it does not contain', (t) => {
  const context = setup(t);
  const newer = addCopy(context, 'newer', { commit: true });
  const landed = git(newer, ['rev-parse', 'HEAD']);
  commitIn(newer, 'after-merge.txt', 'made after the merge\n');
  backdateCopy(newer, 3);
  const stacked = addCopy(context, 'stacked', { commit: true });
  const stackedHead = git(stacked, ['rev-parse', 'HEAD']);
  backdateCopy(stacked, 3);
  fakeGh(t, `case "$*" in
    *work/newer*) echo '[{"number":1,"headRefOid":"${landed}","baseRefName":"master"}]' ;;
    *) echo '[{"number":2,"headRefOid":"${stackedHead}","baseRefName":"some-other-branch"}]' ;;
  esac`);

  const result = run(context, { apply: true });
  assert.equal(result.removed.length, 0);
  assert.equal(keptReason(result, newer), 'unmerged');
  assert.equal(keptReason(result, stacked), 'unmerged');
});

test('a failing gh means not proven, and is only asked once in a run', (t) => {
  const context = setup(t);
  const first = addCopy(context, 'first', { commit: true });
  const second = addCopy(context, 'second', { commit: true });
  const gh = fakeGh(t, 'echo "HTTP 500" >&2; exit 1');
  const result = run(context, { apply: true });
  assert.equal(result.removed.length, 0);
  assert.equal(keptReason(result, first), 'unmerged');
  assert.equal(keptReason(result, second), 'unmerged');
  assert.equal(gh.calls().length, 1);
});

test('a gh that hangs or prints garbage means not proven', (t) => {
  const context = setup(t);
  const copy = addCopy(context, 'hung', { commit: true });
  const gh = fakeGh(t, 'sleep 30');
  const started = Date.now();
  const hung = run(context, { mergedPrTimeoutMs: 300 });
  assert.equal(keptReason(hung, copy), 'unmerged');
  assert.ok(Date.now() - started < 20000, 'the timeout ends the wait');

  gh.answer('echo not json');
  assert.equal(keptReason(run(context), copy), 'unmerged');
});

test('commits already upstream under other ids count as finished', (t) => {
  const context = setup(t);
  const copy = addCopy(context, 'rebased', { commit: true });
  backdateCopy(copy, 3);
  landOnMaster(context, 'rebased.txt', 'rebased\n');
  const gh = fakeGh(t, 'exit 1');
  const result = run(context, { apply: true });
  assert.deepEqual(result.removed.map((item) => item.reason), ['commits_upstream']);
  assert.equal(fs.existsSync(copy), false);
  assert.equal(gh.calls().length, 0, 'git proved it, so GitHub is not asked');
});

test('commits with new content are not cherry-equivalent', (t) => {
  const context = setup(t);
  const copy = addCopy(context, 'partial', { commit: true });
  commitIn(copy, 'not-landed.txt', 'still only here\n');
  backdateCopy(copy, 3);
  landOnMaster(context, 'partial.txt', 'partial\n');
  fakeGh(t, 'exit 1');
  const result = run(context, { apply: true });
  assert.equal(keptReason(result, copy), 'unmerged');
});

test('a copy whose files match the base is finished even with its own history', (t) => {
  const context = setup(t);
  const copy = addCopy(context, 'same-tree', { commit: true });
  git(copy, ['rm', '-q', 'same-tree.txt']);
  git(copy, ['commit', '-qm', 'take it back']);
  backdateCopy(copy, 3);
  fakeGh(t, 'exit 1');
  const result = run(context, { apply: true });
  assert.deepEqual(result.removed.map((item) => item.reason), ['tree_matches_base']);
});

// Locks.

test('a lock older than a day stops protecting an idle finished copy; a newer one still does', (t) => {
  const context = setup(t);
  const stale = addCopy(context, 'stale-lock');
  lockCopy(stale, DAY_HOURS + 1);
  const fresh = addCopy(context, 'fresh-lock');
  lockCopy(fresh, DAY_HOURS - 1);

  const preview = run(context);
  assert.deepEqual(preview.candidates.map((item) => [item.path, item.stale_lock]), [[stale, true]]);
  assert.equal(keptReason(preview, fresh), 'locked');
  assert.match(git(context.root, ['worktree', 'list', '--porcelain']), new RegExp(`worktree ${stale}\\n[^]*?locked someone was here`), 'a preview leaves the lock');

  const applied = run(context, { apply: true });
  assert.deepEqual(applied.removed.map((item) => item.path), [stale]);
  assert.equal(fs.existsSync(stale), false);
  assert.equal(keptReason(applied, fresh), 'locked');
  assert.equal(fs.existsSync(fresh), true);
});

test('a lock on a folder that is gone follows the same age rule', (t) => {
  const context = setup(t);
  const stale = addCopy(context, 'gone-stale-lock');
  lockCopy(stale, DAY_HOURS + 1);
  const fresh = addCopy(context, 'gone-fresh-lock');
  lockCopy(fresh, 1);
  fs.rmSync(stale, { recursive: true });
  fs.rmSync(fresh, { recursive: true });
  const result = run(context, { apply: true });
  assert.deepEqual(result.removed.map((item) => [item.path, item.reason]), [[stale, 'folder_missing']]);
  assert.equal(keptReason(result, fresh), 'locked');
});

test('a failed removal puts the stale lock back', (t) => {
  const context = setup(t);
  const copy = addCopy(context, 'relock');
  lockCopy(copy, DAY_HOURS + 1, 'with a reason');
  // git refuses to remove a copy with a submodule folder in its own files.
  const gitDir = git(copy, ['rev-parse', '--absolute-git-dir']);
  fs.mkdirSync(path.join(gitDir, 'modules', 'sub'), { recursive: true });
  backdateCopy(copy, 3);
  const result = run(context, { apply: true });
  assert.equal(keptReason(result, copy), 'remove_failed');
  assert.equal(fs.readFileSync(path.join(gitDir, 'locked'), 'utf8').trim(), 'with a reason');
});

// A running program always wins.

test('a real program inside a stale, dirty, locked copy protects it, and nothing is saved', async (t) => {
  const context = setup(t);
  const copy = addCopy(context, 'busy', { commit: true });
  fs.writeFileSync(path.join(copy, 'notes.txt'), 'in progress\n');
  backdate(path.join(copy, 'notes.txt'), 5 * DAY_HOURS);
  lockCopy(copy, 5 * DAY_HOURS);
  backdateCopy(copy, 5 * DAY_HOURS);
  const child = spawn('sleep', ['120'], { cwd: copy, stdio: 'ignore' });
  t.after(() => child.kill('SIGKILL'));
  await new Promise((resolve) => child.once('spawn', resolve));

  const result = run(context, { apply: true, activeCwds: undefined });
  assert.equal(keptReason(result, copy), 'active_process');
  assert.equal(fs.readFileSync(path.join(copy, 'notes.txt'), 'utf8'), 'in progress\n');
  assert.equal(fs.existsSync(context.rescueRoot), false);
});

test('an open file inside a copy protects it the same way', (t) => {
  const context = setup(t);
  const copy = addCopy(context, 'open-file', { hoursOld: 5 * DAY_HOURS });
  const result = run(context, { apply: true, activeCwds: [path.join(copy, 'some', 'open.log')] });
  assert.equal(keptReason(result, copy), 'active_process');
  assert.equal(fs.existsSync(copy), true);
});

test('when the process list cannot be read, every copy stays', (t) => {
  const context = setup(t);
  const copy = addCopy(context, 'unknown-scan', { hoursOld: 5 * DAY_HOURS });
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-no-lsof-'));
  t.after(() => fs.rmSync(bin, { recursive: true, force: true }));
  fs.writeFileSync(path.join(bin, 'lsof'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const previous = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${previous}`;
  t.after(() => { process.env.PATH = previous; });
  const result = run(context, { apply: true, activeCwds: undefined });
  assert.equal(keptReason(result, copy), 'process_scan_failed');
});

test('the current working directory is never removed, even when another repo root is being cleaned', (t) => {
  const context = setup(t);
  const copy = addCopy(context, 'here', { hoursOld: 5 * DAY_HOURS });
  const previous = process.cwd();
  process.chdir(copy);
  t.after(() => process.chdir(previous));
  const result = run(context, { apply: true });
  assert.equal(keptReason(result, copy), 'current_checkout');
});

test('the primary checkout is never a candidate', (t) => {
  const context = setup(t);
  const result = run(context, { apply: true, now: Date.now() + 90 * DAY_HOURS * HOUR_MS, maxCopies: 0 });
  assert.equal(keptReason(result, context.root), 'primary_checkout');
  assert.equal(fs.existsSync(context.root), true);
});

test('a copy holding another copy inside is left alone', (t) => {
  const context = setup(t);
  const outer = addCopy(context, 'outer', { hoursOld: 5 * DAY_HOURS });
  const inner = addCopy(context, 'inner', { hoursOld: 5 * DAY_HOURS, at: path.join(outer, 'data', 'inner') });
  fs.writeFileSync(path.join(inner, 'inner-notes.txt'), 'only here\n');
  backdate(path.join(inner, 'inner-notes.txt'), 5 * DAY_HOURS);
  backdateCopy(inner, 5 * DAY_HOURS);
  backdateCopy(outer, 5 * DAY_HOURS);
  const result = run(context, { apply: true });
  assert.equal(keptReason(result, outer), 'holds_another_copy');
  assert.equal(result.removed.some((item) => item.path === inner), true);
  assert.equal(fs.existsSync(outer), true);
});

// Saving before removing.

test('a dirty copy untouched for three days is saved, then removed, and its branch stays', (t) => {
  const context = setup(t);
  const copy = addCopy(context, 'stale-dirty', { commit: true });
  fs.writeFileSync(path.join(copy, 'README.md'), 'edited\n');
  fs.mkdirSync(path.join(copy, 'new-folder'));
  fs.writeFileSync(path.join(copy, 'new-folder', 'draft.txt'), 'untracked draft\n');
  fs.symlinkSync('/etc/hosts', path.join(copy, 'a-link'));
  fs.writeFileSync(path.join(copy, 'staged.txt'), 'staged\n');
  git(copy, ['add', 'staged.txt']);
  for (const file of ['README.md', 'new-folder/draft.txt', 'staged.txt', 'new-folder']) backdate(path.join(copy, file), 4 * DAY_HOURS);
  const longAgo = new Date(Date.now() - 4 * DAY_HOURS * HOUR_MS);
  fs.lutimesSync(path.join(copy, 'a-link'), longAgo, longAgo);
  backdateCopy(copy, 4 * DAY_HOURS);
  fakeGh(t, 'exit 1');

  const result = run(context, { apply: true });
  assert.deepEqual(result.removed.map((item) => [item.path, item.reason, item.action]), [[copy, 'stale_dirty', 'rescue_then_remove']]);
  assert.equal(fs.existsSync(copy), false);
  assert.equal(branchExists(context.root, 'work/stale-dirty'), true);

  const saved = onlyRescue(context);
  assert.equal(result.removed[0].rescue.path, saved);
  assert.equal(path.basename(saved), 'stale-dirty');
  assert.match(path.basename(path.dirname(saved)), /^\d{4}-\d{2}-\d{2}$/);
  for (const dir of [saved, path.dirname(saved)]) assert.equal(modeOf(dir), '700');
  assert.equal(fs.readFileSync(path.join(saved, 'untracked', 'new-folder', 'draft.txt'), 'utf8'), 'untracked draft\n');
  assert.equal(fs.readlinkSync(path.join(saved, 'untracked', 'a-link')), '/etc/hosts', 'a link is saved as a link');
  const manifest = JSON.parse(fs.readFileSync(path.join(saved, 'manifest.json'), 'utf8'));
  assert.equal(manifest.branch, 'work/stale-dirty');
  assert.equal(manifest.reason, 'stale_dirty');

  // The saved work really restores onto the branch.
  const restored = path.join(context.ws, 'restored');
  git(context.root, ['worktree', 'add', '-q', restored, 'work/stale-dirty']);
  git(restored, ['apply', path.join(saved, 'tracked.patch')]);
  assert.equal(fs.readFileSync(path.join(restored, 'README.md'), 'utf8'), 'edited\n');
  assert.equal(fs.readFileSync(path.join(restored, 'staged.txt'), 'utf8'), 'staged\n');
});

test('a recent edit deep in a copy counts as touching it, even with an old folder and reflog', (t) => {
  const context = setup(t);
  const copy = addCopy(context, 'deep-edit');
  fs.mkdirSync(path.join(copy, 'deep'));
  fs.writeFileSync(path.join(copy, 'deep', 'file.txt'), 'edited an hour ago\n');
  backdate(path.join(copy, 'deep', 'file.txt'), 1);
  backdate(path.join(copy, 'deep'), 5 * DAY_HOURS);
  backdateCopy(copy, 5 * DAY_HOURS);
  const result = run(context, { apply: true });
  assert.equal(keptReason(result, copy), 'dirty');
  assert.equal(fs.existsSync(path.join(copy, 'deep', 'file.txt')), true);
});

test('dirty or unfinished copies younger than three days stay', (t) => {
  const context = setup(t);
  const dirty = addCopy(context, 'young-dirty');
  fs.writeFileSync(path.join(dirty, 'notes.txt'), 'today\n');
  backdate(path.join(dirty, 'notes.txt'), 2 * DAY_HOURS);
  backdateCopy(dirty, 2 * DAY_HOURS);
  const unfinished = addCopy(context, 'young-unfinished', { commit: true, hoursOld: 2 * DAY_HOURS });
  fakeGh(t, 'exit 1');
  const result = run(context, { apply: true });
  assert.equal(keptReason(result, dirty), 'dirty');
  assert.equal(keptReason(result, unfinished), 'unmerged');
  assert.equal(fs.existsSync(context.rescueRoot), false);
});

test('an unfinished clean copy untouched for three days leaves a record and keeps its commits on the branch', (t) => {
  const context = setup(t);
  const copy = addCopy(context, 'stale-clean', { commit: true, hoursOld: 4 * DAY_HOURS });
  const head = git(copy, ['rev-parse', 'HEAD']);
  fakeGh(t, 'exit 1');
  const result = run(context, { apply: true });
  assert.deepEqual(result.removed.map((item) => item.reason), ['stale_unfinished']);
  assert.equal(git(context.root, ['rev-parse', 'work/stale-clean']), head);
  assert.equal(JSON.parse(fs.readFileSync(path.join(onlyRescue(context), 'manifest.json'), 'utf8')).head, head);
});

test('commits on a detached head that nothing else reaches are saved as a bundle', (t) => {
  const context = setup(t);
  const copy = path.join(context.ws, 'app-worktrees', 'detached');
  git(context.root, ['worktree', 'add', '-q', '--detach', copy, 'origin/master']);
  const head = commitIn(copy, 'detached.txt', 'only on this head\n');
  backdateCopy(copy, 4 * DAY_HOURS);
  const result = run(context, { apply: true });
  assert.deepEqual(result.removed.map((item) => item.reason), ['stale_unfinished']);
  const saved = onlyRescue(context);
  assert.equal(result.removed[0].rescue.commits_bundle, true);
  git(context.root, ['fetch', '-q', path.join(saved, 'commits.bundle'), 'HEAD']);
  assert.equal(git(context.root, ['rev-parse', 'FETCH_HEAD']), head);
});

test('when the save fails the copy stays, whole, and the failure is reported', (t) => {
  const context = setup(t);
  const copy = addCopy(context, 'cannot-save');
  fs.writeFileSync(path.join(copy, 'notes.txt'), 'irreplaceable\n');
  backdate(path.join(copy, 'notes.txt'), 4 * DAY_HOURS);
  backdateCopy(copy, 4 * DAY_HOURS);
  fs.writeFileSync(context.rescueRoot, 'a file sits where the rescue folder should go');

  const result = run(context, { apply: true });
  assert.equal(result.removed.length, 0);
  const row = result.kept.find((item) => item.path === copy);
  assert.equal(row.reason, 'rescue_failed');
  assert.ok(row.error);
  assert.equal(fs.readFileSync(path.join(copy, 'notes.txt'), 'utf8'), 'irreplaceable\n');
  assert.equal(branchExists(context.root, 'work/cannot-save'), true);
});

test('a save that breaks partway leaves no half rescue behind', (t) => {
  const context = setup(t);
  const copy = addCopy(context, 'half-saved');
  // A linked copy of some other repo sits inside, so this repo's list cannot
  // see it, and its work cannot be judged from here.
  const other = path.join(context.ws, 'other');
  fs.mkdirSync(other);
  git(other, ['init', '-q']);
  git(other, ['-c', 'user.email=t@example.com', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'init']);
  git(other, ['worktree', 'add', '-q', path.join(copy, 'nested')]);
  fs.writeFileSync(path.join(copy, 'a-first.txt'), 'copied before the failure\n');
  for (const file of ['a-first.txt', 'nested']) backdate(path.join(copy, file), 4 * DAY_HOURS);
  backdateCopy(copy, 4 * DAY_HOURS);
  const result = run(context, { apply: true });
  assert.equal(keptReason(result, copy), 'rescue_failed');
  assert.equal(fs.existsSync(copy), true);
  const day = fs.readdirSync(context.rescueRoot)[0];
  assert.deepEqual(fs.readdirSync(path.join(context.rescueRoot, day)), []);
});

test('a file that appears during the check keeps the copy and discards nothing', (t) => {
  const context = setup(t);
  const copy = addCopy(context, 'changed-late');
  fs.writeFileSync(path.join(copy, 'notes.txt'), 'old\n');
  backdate(path.join(copy, 'notes.txt'), 4 * DAY_HOURS);
  backdateCopy(copy, 4 * DAY_HOURS);
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-late-file-'));
  t.after(() => fs.rmSync(bin, { recursive: true, force: true }));
  fs.writeFileSync(path.join(bin, 'du'), '#!/bin/sh\n/usr/bin/du "$@"\nprintf new > "$2/arrived-late.txt"\n', { mode: 0o755 });
  const previous = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${previous}`;
  t.after(() => { process.env.PATH = previous; });
  const result = run(context, { apply: true });
  assert.equal(keptReason(result, copy), 'changed_or_active_during_verification');
  assert.equal(fs.readFileSync(path.join(copy, 'arrived-late.txt'), 'utf8'), 'new');
});

// Ignored files.

test('rebuildable ignored folders are not data: a finished copy holding them is simply removed', (t) => {
  const context = setup(t);
  const copy = addCopy(context, 'rebuildable');
  for (const dir of ['node_modules', '.next', 'dist', 'build', 'venv', '.venv', '__pycache__', '.turbo', '.cache', 'coverage', 'pkg/node_modules']) {
    fs.mkdirSync(path.join(copy, dir), { recursive: true });
    fs.writeFileSync(path.join(copy, dir, 'generated.bin'), 'x');
  }
  backdateCopy(copy, 3);
  const result = run(context, { apply: true });
  assert.deepEqual(result.removed.map((item) => [item.reason, item.action]), [['merged_into_base', 'remove']]);
  assert.equal(fs.existsSync(copy), false);
  assert.equal(fs.existsSync(context.rescueRoot), false);
});

test('rebuildable folders are left out of a save, whatever their size', (t) => {
  const context = setup(t);
  const copy = addCopy(context, 'big-install');
  fs.mkdirSync(path.join(copy, 'node_modules'));
  fs.closeSync(fs.openSync(path.join(copy, 'node_modules', 'huge.bin'), 'w'));
  fs.truncateSync(path.join(copy, 'node_modules', 'huge.bin'), 200 * 1000 * 1000);
  fs.writeFileSync(path.join(copy, '.env'), 'SECRET=1\n', { mode: 0o600 });
  backdate(path.join(copy, '.env'), 3);
  backdateCopy(copy, 3);
  const result = run(context, { apply: true });
  assert.equal(result.removed.length, 1, JSON.stringify(result.kept));
  const saved = onlyRescue(context);
  assert.equal(fs.existsSync(path.join(saved, 'ignored', 'node_modules')), false);
  assert.equal(modeOf(path.join(saved, 'ignored', '.env')), '600', 'a secret keeps its tight mode');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(saved, 'manifest.json'), 'utf8')).not_saved_rebuildable, ['node_modules']);
});

test('other ignored files under the limit are saved before a finished copy goes', (t) => {
  const context = setup(t);
  const copy = addCopy(context, 'small-data');
  fs.mkdirSync(path.join(copy, 'data'));
  fs.writeFileSync(path.join(copy, 'data', 'local.db'), 'local data');
  backdate(path.join(copy, 'data', 'local.db'), 3);
  backdate(path.join(copy, 'data'), 3);
  backdateCopy(copy, 3);
  const result = run(context, { apply: true });
  assert.deepEqual(result.removed.map((item) => [item.reason, item.action]), [['merged_into_base', 'rescue_then_remove']]);
  assert.equal(fs.readFileSync(path.join(onlyRescue(context), 'ignored', 'data', 'local.db'), 'utf8'), 'local data');
});

test('over 50 MB of other ignored files keeps the copy for a person, stale or not', (t) => {
  const context = setup(t);
  const finished = addCopy(context, 'large-finished');
  const stale = addCopy(context, 'large-stale', { commit: true });
  for (const copy of [finished, stale]) {
    fs.mkdirSync(path.join(copy, 'data'));
    fs.closeSync(fs.openSync(path.join(copy, 'data', 'big.db'), 'w'));
    fs.truncateSync(path.join(copy, 'data', 'big.db'), 60 * 1000 * 1000);
    backdate(path.join(copy, 'data', 'big.db'), 5 * DAY_HOURS);
    backdate(path.join(copy, 'data'), 5 * DAY_HOURS);
    backdateCopy(copy, 5 * DAY_HOURS);
  }
  fakeGh(t, 'exit 1');
  const result = run(context, { apply: true });
  assert.equal(result.removed.length, 0);
  assert.equal(keptReason(result, finished), 'ignored_data_large');
  assert.equal(keptReason(result, stale), 'ignored_data_large');
  assert.equal(fs.existsSync(path.join(finished, 'data', 'big.db')), true);
  assert.equal(fs.existsSync(context.rescueRoot), false);
});

// A folder that is gone, and one that is broken.

test('a registered copy whose folder is gone is dropped from git\'s list, and its branch stays', (t) => {
  const context = setup(t);
  const gone = addCopy(context, 'gone', { commit: true });
  fs.rmSync(gone, { recursive: true });
  const preview = run(context);
  assert.deepEqual(preview.candidates.map((item) => [item.path, item.reason, item.action]), [[gone, 'folder_missing', 'forget']]);
  assert.match(git(context.root, ['worktree', 'list']), /gone/, 'a preview leaves the list alone');

  const applied = run(context, { apply: true });
  assert.deepEqual(applied.removed.map((item) => item.reason), ['folder_missing']);
  assert.doesNotMatch(git(context.root, ['worktree', 'list']), /app-worktrees\/gone/);
  assert.equal(branchExists(context.root, 'work/gone'), true);
});

test('a run aimed at one copy forgets only that copy', (t) => {
  const context = setup(t);
  const target = addCopy(context, 'aim');
  const elsewhere = addCopy(context, 'elsewhere');
  fs.rmSync(elsewhere, { recursive: true });
  const result = run(context, { apply: true, onlyPaths: [target] });
  assert.deepEqual(result.removed.map((item) => item.path), [target]);
  assert.match(git(context.root, ['worktree', 'list']), /elsewhere/);
});

test('a folder that lost its .git link is reported, not removed, and git never answers for the repo above it', (t) => {
  const context = setup(t);
  const broken = addCopy(context, 'broken', { hoursOld: 5 * DAY_HOURS });
  fs.rmSync(path.join(broken, '.git'));
  // A repo above the folder, like ~/arena, must not stand in for the copy.
  git(context.ws, ['init', '-q']);
  const result = run(context, { apply: true });
  const row = result.kept.find((item) => item.path === broken);
  assert.equal(row.reason, 'unreadable');
  assert.match(row.error, /\.git link/);
  assert.equal(fs.existsSync(path.join(broken, 'README.md')), true);
});

// The cap.

test('above 15 copies the oldest idle ones are saved and removed, skipping busy and just-used ones', (t) => {
  const context = setup(t);
  const unfinished = [];
  for (let i = 0; i < 16; i++) unfinished.push(addCopy(context, `cap-${i}`, { commit: true, hoursOld: 30 - i }));
  const busy = addCopy(context, 'cap-busy', { commit: true, hoursOld: 60 });
  const justUsed = addCopy(context, 'cap-just-used', { commit: true, hoursOld: 0.1 });
  fakeGh(t, 'exit 1');

  // 18 copies: 3 must go. The busy one is older but protected; the oldest idle go.
  const preview = run(context, { activeCwds: [busy] });
  const expected = [unfinished[0], unfinished[1], unfinished[2]];
  assert.deepEqual(preview.candidates.map((item) => [item.path, item.reason, item.action]), expected.map((copy) => [copy, 'over_cap', 'rescue_then_remove']));
  assert.ok(expected.every((copy) => fs.existsSync(copy)), 'a preview removes nothing');
  assert.equal(fs.existsSync(context.rescueRoot), false, 'a preview saves nothing');

  const applied = run(context, { apply: true, activeCwds: [busy] });
  assert.deepEqual(applied.removed.map((item) => item.path), expected);
  assert.ok(expected.every((copy) => !fs.existsSync(copy)));
  for (const copy of [busy, justUsed, ...unfinished.slice(3)]) assert.equal(fs.existsSync(copy), true, copy);
  assert.equal(branchExists(context.root, 'work/cap-0'), true);
  const copies = git(context.root, ['worktree', 'list']).split('\n').length - 1;
  assert.equal(copies, 15);

  const settled = run(context, { apply: true, activeCwds: [busy] });
  assert.equal(settled.removed.length, 0, 'at the cap, nothing more goes');
});

test('the cap counts what is left after finished copies go, and a copy in the idle window is not idle', (t) => {
  const context = setup(t);
  const finished = [];
  for (let i = 0; i < 4; i++) finished.push(addCopy(context, `done-${i}`));
  const working = [];
  for (let i = 0; i < 13; i++) working.push(addCopy(context, `live-${i}`, { commit: true, hoursOld: 0.5 }));
  fakeGh(t, 'exit 1');
  const first = run(context, { apply: true });
  assert.deepEqual(first.removed.map((item) => item.reason), ['merged_into_base', 'merged_into_base', 'merged_into_base', 'merged_into_base']);

  for (let i = 13; i < 18; i++) working.push(addCopy(context, `live-${i}`, { commit: true, hoursOld: 0.5 }));
  const second = run(context, { apply: true });
  assert.equal(second.removed.length, 0, 'nothing idle to take, even at 18 copies');
  assert.ok(working.every((copy) => fs.existsSync(copy)));
});

// Preview and report.

test('a preview reports exactly what a real run does and changes nothing', (t) => {
  const context = setup(t);
  const finished = addCopy(context, 'preview-finished');
  const staleDirty = addCopy(context, 'preview-dirty');
  fs.writeFileSync(path.join(staleDirty, 'notes.txt'), 'draft\n');
  backdate(path.join(staleDirty, 'notes.txt'), 4 * DAY_HOURS);
  backdateCopy(staleDirty, 4 * DAY_HOURS);
  const gone = addCopy(context, 'preview-gone');
  fs.rmSync(gone, { recursive: true });
  fakeGh(t, 'exit 1');

  const listBefore = git(context.root, ['worktree', 'list', '--porcelain']);
  const preview = run(context);
  assert.equal(git(context.root, ['worktree', 'list', '--porcelain']), listBefore);
  assert.equal(fs.existsSync(context.rescueRoot), false);
  const rows = (items) => items.map((item) => [item.path, item.reason, item.action]).sort();
  assert.deepEqual(rows(preview.candidates), rows([
    { path: finished, reason: 'merged_into_base', action: 'remove' },
    { path: staleDirty, reason: 'stale_dirty', action: 'rescue_then_remove' },
    { path: gone, reason: 'folder_missing', action: 'forget' },
  ]));
  const planned = preview.candidates.find((item) => item.path === staleDirty).rescue;
  assert.equal(planned.untracked_files, 1);

  const applied = run(context, { apply: true });
  assert.deepEqual(rows(applied.removed), rows(preview.candidates));
  assert.equal(applied.removed.find((item) => item.path === staleDirty).rescue.path, planned.path);
});

test('the cleanup command names each copy, what happens to it, and why', (t) => {
  const context = setup(t);
  const finished = addCopy(context, 'printed');
  const unfinished = addCopy(context, 'printed-unfinished', { commit: true });
  fakeGh(t, 'exit 1');
  const previous = process.cwd();
  const lines = [];
  const realLog = console.log;
  console.log = (line = '') => lines.push(String(line));
  t.after(() => { console.log = realLog; process.chdir(previous); });
  process.chdir(context.root);
  assert.equal(worktreeCommand(['cleanup', '--base', 'origin/master']), 0);
  console.log = realLog;
  process.chdir(previous);
  const text = lines.join('\n');
  assert.match(text, new RegExp(`candidate: ${finished} branch=work/printed reason=merged_into_base action=remove`));
  assert.match(text, new RegExp(`keep: ${unfinished} branch=work/printed-unfinished reason=unmerged`));
  assert.equal(fs.existsSync(finished), true);
});

test('removals are logged with where the work was saved', (t) => {
  const context = setup(t);
  const copy = addCopy(context, 'logged');
  fs.writeFileSync(path.join(copy, 'notes.txt'), 'draft\n');
  backdate(path.join(copy, 'notes.txt'), 4 * DAY_HOURS);
  backdateCopy(copy, 4 * DAY_HOURS);
  run(context, { apply: true, by: 'test run' });
  const log = fs.readFileSync(path.join(context.root, '.atris', 'state', 'worktree_removals.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(log[0].reason, 'stale_dirty');
  assert.equal(log[0].by, 'test run');
  assert.equal(log[0].rescue, onlyRescue(context));
});

// The sweep uses the same decision and reaches every usual copy folder.

test('the sweep reaches every usual copy folder, under the same rules', (t) => {
  const context = setup(t);
  const { ws, root } = context;
  const inRepoFolder = addCopy(context, 'sw-sibling');
  const inAgentFolder = addCopy(context, 'sw-agent', { at: path.join(ws, '.agent-worktrees', 'app', 'sw-agent') });
  const insideCheckout = addCopy(context, 'sw-inside', { at: path.join(root, '.claude', 'worktrees', 'sw-inside') });
  const dotted = addCopy(context, 'sw-dotted', { at: path.join(ws, '.wt-sw-dotted') });
  const hand = addCopy(context, 'sw-hand', { at: path.join(ws, 'hand-named-folder') });
  const stale = addCopy(context, 'sw-stale', { commit: true, hoursOld: 5 * DAY_HOURS });
  const goneElsewhere = addCopy(context, 'sw-gone', { at: path.join(ws, 'hand-gone') });
  fs.rmSync(goneElsewhere, { recursive: true });
  fakeGh(t, 'exit 1');

  const dry = sweepWorkspace({ workspace: ws, activeCwds: [], freeSpace: () => 5e9, rescueRoot: context.rescueRoot });
  assert.deepEqual(dry.repos.map((repo) => repo.name), ['app']);
  assert.equal(fs.existsSync(inRepoFolder), true);

  const applied = sweepWorkspace({ workspace: ws, apply: true, activeCwds: [], rescueRoot: context.rescueRoot });
  const report = applied.repos[0];
  assert.deepEqual(report.removed.map((item) => item.path).sort(), [dotted, goneElsewhere, inAgentFolder, inRepoFolder, insideCheckout, stale].sort());
  assert.equal(report.removed.find((item) => item.path === stale).reason, 'stale_unfinished');
  assert.equal(fs.existsSync(hand), true, 'a folder with any other name is left alone');
});
