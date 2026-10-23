'use strict';

// worktreeHasActiveProcess decides whether cleanup and land must keep a work
// folder. A running program inside the folder (or the folder itself) keeps it.
// A folder whose name only shares a prefix with the active one does not. A
// missing process scan (null) keeps everything, since an empty list would read
// as "nobody is here". Every path here lives under a fresh temp folder.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { worktreeHasActiveProcess } = require('../commands/worktree');

function makeTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-wt-active-'));
}

test('a program inside a work folder keeps it, and programs elsewhere do not', () => {
  const root = makeTempRoot();
  try {
    const worktree = path.join(root, 'work', 'wt-a');
    const inside = path.join(worktree, 'src');
    const sibling = path.join(root, 'work', 'wt-a-2');
    const elsewhere = path.join(root, 'other');
    fs.mkdirSync(inside, { recursive: true });
    fs.mkdirSync(sibling, { recursive: true });
    fs.mkdirSync(elsewhere, { recursive: true });

    assert.strictEqual(worktreeHasActiveProcess(worktree, [inside]), true);
    assert.strictEqual(worktreeHasActiveProcess(worktree, [worktree]), true);
    assert.strictEqual(worktreeHasActiveProcess(worktree, [elsewhere]), false);
    assert.strictEqual(worktreeHasActiveProcess(worktree, [sibling]), false);
    assert.strictEqual(worktreeHasActiveProcess(worktree, [elsewhere, inside]), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an empty process list means nobody is inside, but a failed scan keeps the folder', () => {
  const root = makeTempRoot();
  try {
    const worktree = path.join(root, 'wt-b');
    fs.mkdirSync(worktree, { recursive: true });

    // An empty array is a successful scan that found nothing.
    assert.strictEqual(worktreeHasActiveProcess(worktree, []), false);
    // null or a non-array means the scan failed, so cleanup must keep it.
    assert.strictEqual(worktreeHasActiveProcess(worktree, null), true);
    assert.strictEqual(worktreeHasActiveProcess(worktree, undefined), true);
    assert.strictEqual(worktreeHasActiveProcess(worktree, 'not-a-list'), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a symlinked path to the work folder matches the folder it points at', () => {
  const root = makeTempRoot();
  try {
    const worktree = path.join(root, 'real', 'wt-c');
    const inside = path.join(worktree, 'deep');
    const link = path.join(root, 'link');
    fs.mkdirSync(inside, { recursive: true });
    fs.symlinkSync(worktree, link, 'dir');

    // The process reports its cwd through the link; the folder is named by
    // its real path. Both sides canonicalize, so the match still holds.
    assert.strictEqual(worktreeHasActiveProcess(worktree, [path.join(link, 'deep')]), true);
    assert.strictEqual(worktreeHasActiveProcess(path.join(link), [inside]), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
