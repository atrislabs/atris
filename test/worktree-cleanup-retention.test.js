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

// The seeded repo is built once and copied into each test's own root; every
// test still gets a private .git it can add worktrees and commits to.
let seedRoot = null;

function buildSeed() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-worktree-retention-seed-'));
  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 'test@example.com']);
  git(root, ['config', 'user.name', 'Test User']);
  fs.writeFileSync(path.join(root, 'README.md'), 'hello\n');
  fs.writeFileSync(path.join(root, '.gitignore'), '.derivedData/\n.next/\n');
  git(root, ['add', 'README.md', '.gitignore']);
  git(root, ['commit', '-qm', 'init']);
  return root;
}

test.after(() => {
  if (seedRoot) fs.rmSync(seedRoot, { recursive: true, force: true });
});

function initRepo() {
  seedRoot ??= buildSeed();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-worktree-retention-'));
  fs.cpSync(seedRoot, root, { recursive: true });
  return root;
}

function backdate(target, hours) {
  const stamp = new Date(Date.now() - hours * 60 * 60 * 1000);
  fs.utimesSync(target, stamp, stamp);
}

test('cleanup preserves an untracked file even when it resembles agent output', () => {
  const root = initRepo();
  const worktree = `${root}-merged-output`;
  try {
    git(root, ['worktree', 'add', '-q', '-b', 'merged-output', worktree, 'HEAD']);
    const output = path.join(worktree, '.codex-last-message.txt');
    fs.writeFileSync(output, 'finished\n');
    backdate(output, 2);
    backdate(worktree, 2);

    const dryRun = cleanupWorktrees({ root, base: 'HEAD' });
    assert.equal(dryRun.candidates.length, 0);

    const applied = cleanupWorktrees({ root, base: 'HEAD', apply: true });
    assert.equal(applied.removed.length, 0);
    assert.equal(fs.readFileSync(output, 'utf8'), 'finished\n');
    assert.equal(git(root, ['show-ref', '--verify', '--hash', 'refs/heads/merged-output']).length > 0, true);
  } finally {
    spawnSync('git', ['worktree', 'remove', '--force', worktree], { cwd: root });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('cleanup keeps a named unmerged checkout even with an old output file', () => {
  const root = initRepo();
  const worktree = `${root}-unmerged-output`;
  try {
    git(root, ['worktree', 'add', '-q', '-b', 'unmerged-output', worktree, 'HEAD']);
    fs.writeFileSync(path.join(worktree, 'work.txt'), 'kept in branch\n');
    const output = path.join(worktree, '.codex-last-message.txt');
    fs.writeFileSync(output, 'finished\n');
    git(worktree, ['add', 'work.txt', '.codex-last-message.txt']);
    git(worktree, ['commit', '-qm', 'unmerged work']);
    backdate(output, 2);

    const applied = cleanupWorktrees({ root, base: 'HEAD', apply: true });
    assert.equal(applied.removed.length, 0);
    assert.equal(applied.kept.some((item) => item.reason === 'unmerged'), true);
    assert.equal(fs.existsSync(worktree), true);
    assert.equal(git(root, ['show-ref', '--verify', '--hash', 'refs/heads/unmerged-output']).length > 0, true);
  } finally {
    spawnSync('git', ['worktree', 'remove', '--force', worktree], { cwd: root });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('cleanup keeps a detached unmerged commit even with an old completion output', () => {
  const root = initRepo();
  const worktree = `${root}-detached-output`;
  try {
    git(root, ['worktree', 'add', '-q', '--detach', worktree, 'HEAD']);
    fs.writeFileSync(path.join(worktree, 'work.txt'), 'only in detached commit\n');
    const output = path.join(worktree, '.codex-last-message.txt');
    fs.writeFileSync(output, 'finished\n');
    git(worktree, ['add', 'work.txt', '.codex-last-message.txt']);
    git(worktree, ['commit', '-qm', 'detached work']);
    const head = git(worktree, ['rev-parse', 'HEAD']);
    backdate(output, 2);
    backdate(worktree, 2);
    const result = cleanupWorktrees({ root, base: 'HEAD', apply: true, activeCwds: [] });
    assert.equal(result.removed.length, 0);
    assert.equal(result.kept.some((item) => item.reason === 'detached_unmerged'), true);
    assert.equal(git(worktree, ['rev-parse', 'HEAD']), head);
  } finally {
    spawnSync('git', ['worktree', 'remove', '--force', worktree], { cwd: root });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('cleanup preserves edits to a tracked file named like agent output', () => {
  const root = initRepo();
  const worktree = `${root}-tracked-output`;
  try {
    fs.writeFileSync(path.join(root, '.codex-last-message.txt'), 'tracked\n');
    git(root, ['add', '.codex-last-message.txt']);
    git(root, ['commit', '-qm', 'track output']);
    git(root, ['worktree', 'add', '-q', '-b', 'tracked-output', worktree, 'HEAD']);
    const output = path.join(worktree, '.codex-last-message.txt');
    fs.writeFileSync(output, 'user change\n');
    backdate(worktree, 2);
    const result = cleanupWorktrees({ root, base: 'HEAD', apply: true, activeCwds: [] });
    assert.equal(result.removed.length, 0);
    assert.equal(result.kept.some((item) => item.reason === 'dirty'), true);
    assert.equal(fs.readFileSync(output, 'utf8'), 'user change\n');
  } finally {
    spawnSync('git', ['worktree', 'remove', '--force', worktree], { cwd: root });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('cleanup preserves ignored local data in an otherwise clean merged checkout', () => {
  const root = initRepo();
  const worktree = `${root}-ignored-data`;
  try {
    git(root, ['worktree', 'add', '-q', '-b', 'ignored-data', worktree, 'HEAD']);
    fs.mkdirSync(path.join(worktree, '.derivedData'));
    fs.writeFileSync(path.join(worktree, '.derivedData', 'local.db'), 'local data');
    backdate(worktree, 2);
    const result = cleanupWorktrees({ root, base: 'HEAD', apply: true, activeCwds: [] });
    assert.equal(result.removed.length, 0);
    assert.equal(result.kept.some((item) => item.reason === 'ignored_data'), true);
    assert.equal(fs.readFileSync(path.join(worktree, '.derivedData', 'local.db'), 'utf8'), 'local data');
  } finally {
    spawnSync('git', ['worktree', 'remove', '--force', worktree], { cwd: root });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('cleanup keeps a checkout when its remote base cannot be refreshed', () => {
  const root = initRepo();
  const worktree = `${root}-unreachable-base`;
  try {
    git(root, ['remote', 'add', 'origin', path.join(root, 'missing-remote.git')]);
    git(root, ['update-ref', 'refs/remotes/origin/main', git(root, ['rev-parse', 'HEAD'])]);
    git(root, ['worktree', 'add', '-q', '-b', 'unreachable-base', worktree, 'HEAD']);
    backdate(worktree, 2);
    const result = cleanupWorktrees({ root, base: 'origin/main', apply: true, activeCwds: [] });
    assert.equal(result.removed.length, 0);
    assert.equal(result.kept.some((item) => item.reason === 'base_refresh_failed'), true);
    assert.equal(fs.existsSync(worktree), true);
  } finally {
    spawnSync('git', ['worktree', 'remove', '--force', worktree], { cwd: root });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('cleanup removes a merged copy after verifying the real remote base', () => {
  const root = initRepo();
  const worktree = `${root}-verified-base`;
  const remote = `${root}-origin.git`;
  try {
    git(root, ['init', '--bare', '-q', remote]);
    git(root, ['remote', 'add', 'origin', remote]);
    git(root, ['push', '-q', 'origin', 'HEAD:refs/heads/main']);
    git(root, ['fetch', '-q', 'origin', 'main']);
    git(root, ['worktree', 'add', '-q', '-b', 'verified-base', worktree, 'HEAD']);
    backdate(worktree, 2);
    const result = cleanupWorktrees({ root, base: 'origin/main', apply: true, activeCwds: [] });
    assert.equal(result.removed.length, 1, JSON.stringify(result));
    assert.equal(fs.existsSync(worktree), false);
    assert.equal(git(root, ['show-ref', '--verify', '--hash', 'refs/heads/verified-base']).length > 0, true);
  } finally {
    spawnSync('git', ['worktree', 'remove', '--force', worktree], { cwd: root });
    fs.rmSync(remote, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('cleanup does not treat an unrelated local feature branch as the base', () => {
  const root = initRepo();
  const worktree = `${root}-feature-base`;
  try {
    git(root, ['checkout', '-qb', 'feature-base']);
    git(root, ['worktree', 'add', '-q', '-b', 'feature-copy', worktree, 'HEAD']);
    backdate(worktree, 2);
    const result = cleanupWorktrees({ root, base: 'HEAD', apply: true, activeCwds: [] });
    assert.equal(result.removed.length, 0);
    assert.equal(result.kept.some((item) => item.reason === 'base_unverified'), true);
    assert.equal(fs.existsSync(worktree), true);
  } finally {
    spawnSync('git', ['worktree', 'remove', '--force', worktree], { cwd: root });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('cleanup keeps a checkout above the per-run size limit', () => {
  const root = initRepo();
  const worktree = `${root}-oversize`;
  const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-cleanup-size-'));
  const previousPath = process.env.PATH;
  try {
    git(root, ['worktree', 'add', '-q', '-b', 'oversize', worktree, 'HEAD']);
    backdate(worktree, 2);
    fs.writeFileSync(path.join(fakeBin, 'du'), '#!/bin/sh\nprintf "10485761\\t%s\\n" "$2"\n', { mode: 0o755 });
    process.env.PATH = `${fakeBin}${path.delimiter}${previousPath}`;
    const result = cleanupWorktrees({ root, base: 'HEAD', apply: true, activeCwds: [] });
    assert.equal(result.removed.length, 0);
    assert.equal(result.kept.some((item) => item.reason === 'size_unknown_or_cleanup_limit'), true);
    assert.equal(fs.existsSync(worktree), true);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    spawnSync('git', ['worktree', 'remove', '--force', worktree], { cwd: root });
    fs.rmSync(fakeBin, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('cleanup keeps local data created after the initial inspection', () => {
  const root = initRepo();
  const worktree = `${root}-changed-during-check`;
  const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-cleanup-race-'));
  const previousPath = process.env.PATH;
  try {
    fs.appendFileSync(path.join(root, '.gitignore'), '.env\n');
    git(root, ['add', '.gitignore']);
    git(root, ['commit', '-qm', 'ignore local environment']);
    git(root, ['worktree', 'add', '-q', '-b', 'changed-during-check', worktree, 'HEAD']);
    backdate(worktree, 2);
    fs.writeFileSync(path.join(fakeBin, 'du'), '#!/bin/sh\n/usr/bin/du "$@"\nprintf local > "$2/.env"\n', { mode: 0o755 });
    process.env.PATH = `${fakeBin}${path.delimiter}${previousPath}`;
    const result = cleanupWorktrees({ root, base: 'HEAD', apply: true, activeCwds: [] });
    assert.equal(result.removed.length, 0);
    assert.equal(result.kept.some((item) => item.reason === 'changed_or_active_during_verification'), true);
    assert.equal(fs.readFileSync(path.join(worktree, '.env'), 'utf8'), 'local');
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    spawnSync('git', ['worktree', 'remove', '--force', worktree], { cwd: root });
    fs.rmSync(fakeBin, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('cleanup previews no more than twenty copies in one run', () => {
  const root = initRepo();
  const worktrees = [];
  try {
    for (let i = 0; i < 21; i++) {
      const worktree = `${root}-limit-${i}`;
      git(root, ['worktree', 'add', '-q', '-b', `limit-${i}`, worktree, 'HEAD']);
      backdate(worktree, 2);
      worktrees.push(worktree);
    }
    const result = cleanupWorktrees({ root, base: 'HEAD', activeCwds: [] });
    assert.equal(result.candidates.length, 20);
    assert.equal(result.kept.filter((item) => item.reason === 'size_unknown_or_cleanup_limit').length, 1);
    assert.equal(worktrees.every((worktree) => fs.existsSync(worktree)), true);
  } finally {
    for (const worktree of worktrees) spawnSync('git', ['worktree', 'remove', '--force', worktree], { cwd: root });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('cleanup never removes an old merged worktree with a live process cwd', () => {
  const root = initRepo();
  const worktree = `${root}-active`;
  try {
    git(root, ['worktree', 'add', '-q', '-b', 'active-worktree', worktree, 'HEAD']);
    backdate(worktree, 2);

    const applied = cleanupWorktrees({ root, base: 'HEAD', apply: true, activeCwds: [worktree] });
    assert.equal(applied.removed.length, 0);
    assert.equal(applied.kept.some((item) => item.reason === 'active_process'), true);
    assert.equal(fs.existsSync(worktree), true);
  } finally {
    spawnSync('git', ['worktree', 'remove', '--force', worktree], { cwd: root });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('starting a worktree reaps completed checkout debt before creating another copy', () => {
  const root = initRepo();
  const oldWorktree = `${root}-old`;
  let created;
  try {
    git(root, ['worktree', 'add', '-q', '-b', 'old-worktree', oldWorktree, 'HEAD']);
    backdate(oldWorktree, 2);

    created = createAgentWorktree({ root, agent: 'tester', task: 'new worktree' });
    assert.equal(created.reapedBeforeStart.length, 1);
    assert.equal(fs.existsSync(oldWorktree), false);
    assert.equal(fs.existsSync(created.path), true);
  } finally {
    if (created) spawnSync('git', ['worktree', 'remove', '--force', created.path], { cwd: root });
    spawnSync('git', ['worktree', 'remove', '--force', oldWorktree], { cwd: root });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('cleanup reports ignored caches in dirty worktrees without deleting unverified data', () => {
  const root = initRepo();
  const worktree = `${root}-dirty-cache`;
  try {
    git(root, ['worktree', 'add', '-q', '-b', 'dirty-cache', worktree, 'HEAD']);
    fs.writeFileSync(path.join(worktree, 'README.md'), 'real source change\n');
    const cache = path.join(worktree, '.derivedData');
    fs.mkdirSync(cache, { recursive: true });
    fs.writeFileSync(path.join(cache, 'cache.bin'), 'generated\n');
    backdate(worktree, 2);

    const applied = cleanupWorktrees({ root, base: 'HEAD', apply: true, activeCwds: [] });
    assert.equal(applied.removed.length, 0);
    assert.equal(applied.cachePruned.length, 0);
    assert.equal(applied.cacheCandidates[0].reason, 'manual_review_required');
    assert.equal(fs.existsSync(cache), true);
    assert.equal(fs.readFileSync(path.join(worktree, 'README.md'), 'utf8'), 'real source change\n');
    assert.equal(applied.kept.some((item) => item.reason === 'dirty'), true);
  } finally {
    spawnSync('git', ['worktree', 'remove', '--force', worktree], { cwd: root });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('cleanup removes verified webpack packs but preserves other ignored data', () => {
  const root = initRepo();
  const worktree = `${root}-webpack-cache`;
  try {
    git(root, ['worktree', 'add', '-q', '-b', 'webpack-cache', worktree, 'HEAD']);
    fs.writeFileSync(path.join(worktree, 'README.md'), 'real source change\n');
    const cache = path.join(worktree, '.next', 'cache', 'webpack');
    fs.mkdirSync(path.join(cache, 'client-production'), { recursive: true });
    fs.writeFileSync(path.join(cache, 'client-production', '0.pack'), 'rebuildable');
    const other = path.join(worktree, '.next', 'cache', 'local.db');
    fs.writeFileSync(other, 'local data');
    backdate(worktree, 2);
    const result = cleanupWorktrees({ root, base: 'HEAD', apply: true, activeCwds: [] });
    assert.equal(result.cachePruned.length, 1, JSON.stringify(result));
    assert.equal(fs.existsSync(cache), false);
    assert.equal(fs.readFileSync(other, 'utf8'), 'local data');
    assert.equal(fs.readFileSync(path.join(worktree, 'README.md'), 'utf8'), 'real source change\n');
  } finally {
    spawnSync('git', ['worktree', 'remove', '--force', worktree], { cwd: root });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('cleanup leaves a webpack cache containing unexpected data', () => {
  const root = initRepo();
  const worktree = `${root}-webpack-unknown`;
  try {
    git(root, ['worktree', 'add', '-q', '-b', 'webpack-unknown', worktree, 'HEAD']);
    fs.writeFileSync(path.join(worktree, 'README.md'), 'real source change\n');
    const cache = path.join(worktree, '.next', 'cache', 'webpack');
    fs.mkdirSync(cache, { recursive: true });
    fs.writeFileSync(path.join(cache, 'local.db'), 'local data');
    backdate(worktree, 2);
    const result = cleanupWorktrees({ root, base: 'HEAD', apply: true, activeCwds: [] });
    assert.equal(result.cachePruned.length, 0);
    assert.equal(fs.readFileSync(path.join(cache, 'local.db'), 'utf8'), 'local data');
  } finally {
    spawnSync('git', ['worktree', 'remove', '--force', worktree], { cwd: root });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('cleanup does not follow a webpack cache symlink', () => {
  const root = initRepo();
  const worktree = `${root}-webpack-link`;
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-cache-outside-'));
  try {
    git(root, ['worktree', 'add', '-q', '-b', 'webpack-link', worktree, 'HEAD']);
    fs.writeFileSync(path.join(worktree, 'README.md'), 'real source change\n');
    const parent = path.join(worktree, '.next', 'cache');
    fs.mkdirSync(parent, { recursive: true });
    fs.writeFileSync(path.join(outside, '0.pack'), 'keep');
    fs.symlinkSync(outside, path.join(parent, 'webpack'), 'dir');
    backdate(worktree, 2);
    const result = cleanupWorktrees({ root, base: 'HEAD', apply: true, activeCwds: [] });
    assert.equal(result.cachePruned.length, 0);
    assert.equal(fs.readFileSync(path.join(outside, '0.pack'), 'utf8'), 'keep');
  } finally {
    spawnSync('git', ['worktree', 'remove', '--force', worktree], { cwd: root });
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
