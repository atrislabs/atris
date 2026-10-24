'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveMemberWorkspaceRoot } = require('../commands/mission');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-member-root-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('ordinary roots are normalized without requiring an existing workspace', (t) => {
  const root = fixture(t);
  const input = path.join(root, 'missing', 'child', '..', 'workspace');
  assert.strictEqual(resolveMemberWorkspaceRoot(input), path.join(root, 'missing', 'workspace'));
  assert.strictEqual(fs.existsSync(path.join(root, 'missing')), false);
});

test('agent worktrees resolve to the named primary repository only when it has atris', (t) => {
  const root = fixture(t);
  const primary = path.join(root, 'sample-repo');
  const worktree = path.join(root, '.agent-worktrees', 'sample-repo', 'lane', 'member');
  fs.mkdirSync(worktree, { recursive: true });
  fs.mkdirSync(primary);
  // A repository directory alone is not enough to redirect member state.
  assert.strictEqual(resolveMemberWorkspaceRoot(worktree), worktree);
  fs.mkdirSync(path.join(primary, 'atris'));
  assert.strictEqual(resolveMemberWorkspaceRoot(worktree), primary);
  const other = path.join(root, '.agent-worktrees', 'other-repo', 'member');
  assert.strictEqual(resolveMemberWorkspaceRoot(other), other);
});

test('local atris worktrees resolve to their parent only when its atris exists', (t) => {
  const root = fixture(t);
  const worktree = path.join(root, '.atris', 'worktrees', 'member');
  fs.mkdirSync(worktree, { recursive: true });
  assert.strictEqual(resolveMemberWorkspaceRoot(worktree), worktree);
  fs.mkdirSync(path.join(root, 'atris'));
  assert.strictEqual(resolveMemberWorkspaceRoot(worktree), root);
  const lookalike = path.join(root, '.atris', 'worktrees-other', 'member');
  assert.strictEqual(resolveMemberWorkspaceRoot(lookalike), lookalike);
});

test('omitted, empty, and null roots fall back to the current directory', (t) => {
  const root = fixture(t);
  const previous = process.cwd();
  try {
    process.chdir(root);
    // cwd may canonicalize a temporary-directory symlink on some systems.
    const expected = process.cwd();
    assert.strictEqual(resolveMemberWorkspaceRoot(), expected);
    assert.strictEqual(resolveMemberWorkspaceRoot(''), expected);
    assert.strictEqual(resolveMemberWorkspaceRoot(null), expected);
    assert.strictEqual(resolveMemberWorkspaceRoot('child/../workspace'), path.join(expected, 'workspace'));
  } finally {
    process.chdir(previous);
  }
});
