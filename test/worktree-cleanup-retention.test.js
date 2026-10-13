'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { cleanupWorktrees, createAgentWorktree } = require('../commands/worktree');

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return String(result.stdout || '').trim();
}

// <arena>/repo with a bare origin; copies go where launchers put them,
// <arena>/.agent-worktrees/repo/<name>.
function initArena() {
  const arena = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-worktree-retention-')));
  const root = path.join(arena, 'repo');
  const bare = path.join(arena, 'origin.git');
  fs.mkdirSync(root);
  git(arena, ['init', '-q', '--bare', bare]);
  git(root, ['init', '-q', '-b', 'master']);
  git(root, ['config', 'user.email', 'test@example.com']);
  git(root, ['config', 'user.name', 'Test User']);
  fs.writeFileSync(path.join(root, 'README.md'), 'hello\n');
  fs.writeFileSync(path.join(root, '.gitignore'), '.derivedData/\n');
  git(root, ['add', 'README.md', '.gitignore']);
  git(root, ['commit', '-qm', 'init']);
  git(root, ['remote', 'add', 'origin', bare]);
  git(root, ['push', '-q', 'origin', 'master']);
  return { arena, root };
}

function copyPath(arena, name) {
  const wt = path.join(arena, '.agent-worktrees', 'repo', name);
  fs.mkdirSync(path.dirname(wt), { recursive: true });
  return wt;
}

function backdate(target, hours) {
  const stamp = new Date(Date.now() - hours * 60 * 60 * 1000);
  fs.utimesSync(target, stamp, stamp);
}

const noPrs = () => ({ state: 'none', prs: [] });

test('cleanup keeps a merged copy that still holds the agent output file', () => {
  const { arena, root } = initArena();
  try {
    const worktree = copyPath(arena, 'merged-output');
    git(root, ['worktree', 'add', '-q', '-b', 'merged-output', worktree, 'origin/master']);
    fs.writeFileSync(path.join(worktree, '.codex-last-message.txt'), 'finished\n');
    backdate(worktree, 2);

    const applied = cleanupWorktrees({ root, apply: true, activeCwds: [], prLookup: noPrs });
    assert.equal(applied.removed.length, 0);
    assert.equal(applied.kept[0].reason, 'untracked_files');
    assert.equal(fs.existsSync(path.join(worktree, '.codex-last-message.txt')), true);
  } finally {
    fs.rmSync(arena, { recursive: true, force: true });
  }
});

test('cleanup never expires a finished copy whose work has not landed', () => {
  const { arena, root } = initArena();
  try {
    const worktree = copyPath(arena, 'unmerged-output');
    git(root, ['worktree', 'add', '-q', '-b', 'unmerged-output', worktree, 'origin/master']);
    fs.writeFileSync(path.join(worktree, 'work.txt'), 'kept in branch\n');
    git(worktree, ['add', 'work.txt']);
    git(worktree, ['commit', '-qm', 'unmerged work']);
    backdate(worktree, 5);

    const applied = cleanupWorktrees({ root, apply: true, activeCwds: [], prLookup: noPrs });
    assert.equal(applied.removed.length, 0);
    assert.equal(applied.kept[0].reason, 'not_on_github');
    assert.equal(fs.existsSync(worktree), true);
  } finally {
    fs.rmSync(arena, { recursive: true, force: true });
  }
});

test('cleanup never removes an old merged worktree with a live process cwd', () => {
  const { arena, root } = initArena();
  try {
    const worktree = copyPath(arena, 'active');
    git(root, ['worktree', 'add', '-q', '-b', 'active-worktree', worktree, 'origin/master']);
    backdate(worktree, 2);

    const applied = cleanupWorktrees({ root, apply: true, activeCwds: [worktree], prLookup: noPrs });
    assert.equal(applied.removed.length, 0);
    assert.equal(applied.kept.some((item) => item.reason === 'active_process'), true);
    assert.equal(fs.existsSync(worktree), true);
  } finally {
    fs.rmSync(arena, { recursive: true, force: true });
  }
});

test('starting a worktree puts a finished copy away before creating another', () => {
  const { arena, root } = initArena();
  let created;
  try {
    const oldWorktree = copyPath(arena, 'old');
    git(root, ['worktree', 'add', '-q', '-b', 'old-worktree', oldWorktree, 'origin/master']);
    backdate(oldWorktree, 2);
    // Nothing else may be open in the old copy for it to go; no test process is.
    created = createAgentWorktree({ root, agent: 'tester', task: 'new worktree' });
    assert.equal(created.reapedBeforeStart.length, 1);
    assert.equal(fs.existsSync(oldWorktree), false);
    assert.equal(fs.existsSync(created.path), true);
  } finally {
    fs.rmSync(arena, { recursive: true, force: true });
  }
});

test('cleanup never deletes cache folders inside a copy it keeps', () => {
  const { arena, root } = initArena();
  try {
    const worktree = copyPath(arena, 'dirty-cache');
    git(root, ['worktree', 'add', '-q', '-b', 'dirty-cache', worktree, 'origin/master']);
    fs.writeFileSync(path.join(worktree, 'README.md'), 'real source change\n');
    const cache = path.join(worktree, '.derivedData');
    fs.mkdirSync(cache, { recursive: true });
    fs.writeFileSync(path.join(cache, 'cache.bin'), 'generated\n');
    backdate(worktree, 2);

    const applied = cleanupWorktrees({ root, apply: true, activeCwds: [], prLookup: noPrs });
    assert.equal(applied.removed.length, 0);
    assert.equal(fs.existsSync(path.join(cache, 'cache.bin')), true);
    assert.equal(fs.readFileSync(path.join(worktree, 'README.md'), 'utf8'), 'real source change\n');
    assert.equal(applied.kept[0].reason, 'uncommitted_changes');
  } finally {
    fs.rmSync(arena, { recursive: true, force: true });
  }
});
