'use strict';

// A finished copy that holds only atris's own run notes (day journal, engine
// run records, receipts, local state) is removed by cleanup after those notes
// are copied to the saved-copies folder. Other ignored data still keeps it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { cleanupWorktrees } = require('../commands/worktree');

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return String(result.stdout || '').trim();
}

function initRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-saves-notes-'));
  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 'test@example.com']);
  git(root, ['config', 'user.name', 'Test User']);
  fs.writeFileSync(path.join(root, 'README.md'), 'hello\n');
  fs.writeFileSync(path.join(root, '.gitignore'), 'atris/logs/\natris/runs/\n.atris/\nlocal-data/\n');
  git(root, ['add', 'README.md', '.gitignore']);
  git(root, ['commit', '-qm', 'init']);
  return root;
}

function write(base, rel, text) {
  const file = path.join(base, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function backdateTree(dir, hours) {
  const stamp = new Date(Date.now() - hours * 60 * 60 * 1000);
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) backdateTree(full, hours);
    fs.utimesSync(full, stamp, stamp);
  }
  fs.utimesSync(dir, stamp, stamp);
}

function withSavedDir(fn) {
  const saved = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-saved-copies-'));
  const before = process.env.ATRIS_SAVED_COPIES_DIR;
  process.env.ATRIS_SAVED_COPIES_DIR = saved;
  try {
    return fn(saved);
  } finally {
    if (before === undefined) delete process.env.ATRIS_SAVED_COPIES_DIR;
    else process.env.ATRIS_SAVED_COPIES_DIR = before;
    fs.rmSync(saved, { recursive: true, force: true });
  }
}

test('cleanup saves atris run notes and then removes the finished copy', () => withSavedDir((saved) => {
  const root = initRepo();
  const worktree = `${root}-notes-only`;
  try {
    git(root, ['worktree', 'add', '-q', '-b', 'notes-only', worktree, 'HEAD']);
    write(worktree, 'atris/logs/2026/2026-11-19.md', 'journal\n');
    write(worktree, 'atris/runs/engine-ask-1.json', '{"ok":true}\n');
    write(worktree, '.atris/receipts/check-1.json', '{}\n');
    write(worktree, '.atris/state/feed/waiting.json', '[]\n');
    write(worktree, '.atris/search_index.sqlite', 'index');
    backdateTree(worktree, 2);

    const result = cleanupWorktrees({ root, base: 'HEAD', apply: true, activeCwds: [] });
    assert.equal(result.removed.length, 1, JSON.stringify(result.kept));
    assert.equal(fs.existsSync(worktree), false);

    const dir = path.join(saved, path.basename(root), path.basename(worktree));
    assert.equal(result.removed[0].notes_saved_to, dir);
    assert.equal(fs.readFileSync(path.join(dir, 'atris/logs/2026/2026-11-19.md'), 'utf8'), 'journal\n');
    assert.equal(fs.readFileSync(path.join(dir, 'atris/runs/engine-ask-1.json'), 'utf8'), '{"ok":true}\n');
    assert.equal(fs.existsSync(path.join(dir, '.atris/receipts/check-1.json')), true);
    assert.equal(fs.existsSync(path.join(dir, '.atris/state/feed/waiting.json')), true);
    // The search index comes back on its own, so it is not saved.
    assert.equal(fs.existsSync(path.join(dir, '.atris/search_index.sqlite')), false);
  } finally {
    spawnSync('git', ['worktree', 'remove', '--force', worktree], { cwd: root });
    fs.rmSync(root, { recursive: true, force: true });
  }
}));

test('cleanup still keeps a copy that also holds other ignored data', () => withSavedDir((saved) => {
  const root = initRepo();
  const worktree = `${root}-notes-and-data`;
  try {
    git(root, ['worktree', 'add', '-q', '-b', 'notes-and-data', worktree, 'HEAD']);
    write(worktree, 'atris/logs/2026/2026-11-19.md', 'journal\n');
    write(worktree, 'local-data/local.db', 'local data');
    backdateTree(worktree, 2);

    const result = cleanupWorktrees({ root, base: 'HEAD', apply: true, activeCwds: [] });
    assert.equal(result.removed.length, 0);
    assert.deepEqual(result.kept.find((item) => item.reason === 'ignored_data').files, ['local-data/local.db']);
    assert.equal(fs.readFileSync(path.join(worktree, 'local-data/local.db'), 'utf8'), 'local data');
    assert.equal(fs.existsSync(path.join(saved, path.basename(root))), false);
  } finally {
    spawnSync('git', ['worktree', 'remove', '--force', worktree], { cwd: root });
    fs.rmSync(root, { recursive: true, force: true });
  }
}));
