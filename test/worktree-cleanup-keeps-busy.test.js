'use strict';

// Cleanup must never delete a work folder a running program is using. These
// cases drive the real `atris worktree cleanup --apply` with no injected
// process list: a live program sitting in the folder keeps it, and a process
// scan that fails keeps every folder instead of reading as "nobody is here".

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const cliPath = path.resolve(__dirname, '..', 'bin', 'atris.js');

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return String(result.stdout || '').trim();
}

// A repo with one merged, clean, two-hour-old work folder: exactly what
// cleanup removes when nothing protects it.
function initRepoWithOldWorktree(label) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `atris-keeps-busy-${label}-`)));
  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 'test@example.com']);
  git(root, ['config', 'user.name', 'Test User']);
  fs.writeFileSync(path.join(root, 'README.md'), 'hello\n');
  git(root, ['add', 'README.md']);
  git(root, ['commit', '-qm', 'init']);
  const worktree = `${root}-wt`;
  git(root, ['worktree', 'add', '-q', '-b', `busy-${label}`, worktree, 'HEAD']);
  const stamp = new Date(Date.now() - 2 * 60 * 60 * 1000);
  fs.utimesSync(worktree, stamp, stamp);
  return { root, worktree };
}

function runCleanup(root, env = process.env) {
  const result = spawnSync(process.execPath, [cliPath, 'worktree', 'cleanup', '--apply', '--base', 'HEAD', '--json'], {
    cwd: root,
    encoding: 'utf8',
    env,
    timeout: 60000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout.slice(result.stdout.indexOf('{')));
}

function cleanupAll({ root, worktree }) {
  spawnSync('git', ['worktree', 'remove', '--force', worktree], { cwd: root });
  fs.rmSync(worktree, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
}

test('control: an idle old merged work folder is removed', () => {
  const repo = initRepoWithOldWorktree('idle');
  try {
    const result = runCleanup(repo.root);
    assert.equal(result.removed.length, 1);
    assert.equal(fs.existsSync(repo.worktree), false);
  } finally {
    cleanupAll(repo);
  }
});

test('a real program running inside the work folder keeps it', async () => {
  const repo = initRepoWithOldWorktree('live');
  const child = spawn('sleep', ['60'], { cwd: repo.worktree, stdio: 'ignore' });
  try {
    await new Promise((resolve) => child.once('spawn', resolve));
    const result = runCleanup(repo.root);
    assert.equal(result.removed.length, 0);
    assert.equal(fs.existsSync(repo.worktree), true);
    const kept = result.kept.find((item) => fs.realpathSync(item.path) === repo.worktree);
    assert.equal(kept && kept.reason, 'active_process');
  } finally {
    child.kill('SIGKILL');
    cleanupAll(repo);
  }
});

test('an open file keeps its work folder even when the program runs elsewhere', async () => {
  const repo = initRepoWithOldWorktree('open-file');
  const child = spawn(process.execPath, ['-e', "require('fs').openSync(process.env.TEST_OPEN_FILE, 'r'); console.log('ready'); setInterval(() => {}, 1000)"], {
    cwd: os.tmpdir(), env: { ...process.env, TEST_OPEN_FILE: path.join(repo.worktree, 'README.md') }, stdio: ['ignore', 'pipe', 'ignore'],
  });
  try {
    await new Promise((resolve, reject) => {
      child.stdout.once('data', resolve);
      child.once('error', reject);
      child.once('exit', (code) => reject(new Error(`child exited ${code} before opening file`)));
    });
    const result = runCleanup(repo.root);
    assert.equal(result.removed.length, 0);
    assert.equal(result.kept.find((item) => item.path === repo.worktree)?.reason, 'active_process');
    assert.equal(fs.existsSync(repo.worktree), true);
  } finally {
    child.kill('SIGKILL');
    cleanupAll(repo);
  }
});

test('a failed process scan keeps every work folder', () => {
  const repo = initRepoWithOldWorktree('scanfail');
  const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-keeps-busy-bin-'));
  try {
    fs.writeFileSync(path.join(fakeBin, 'lsof'), '#!/bin/sh\necho "lsof: broken" >&2\nexit 1\n', { mode: 0o755 });
    const env = { ...process.env, PATH: `${fakeBin}${path.delimiter}${process.env.PATH}` };
    const result = runCleanup(repo.root, env);
    assert.equal(result.removed.length, 0);
    assert.equal(fs.existsSync(repo.worktree), true);
    const kept = result.kept.find((item) => fs.realpathSync(item.path) === repo.worktree);
    assert.equal(kept && kept.reason, 'process_scan_failed');
  } finally {
    fs.rmSync(fakeBin, { recursive: true, force: true });
    cleanupAll(repo);
  }
});

test('a failed command-line scan also keeps every work folder', () => {
  const repo = initRepoWithOldWorktree('psfail');
  const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-keeps-busy-ps-'));
  try {
    fs.writeFileSync(path.join(fakeBin, 'ps'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const env = { ...process.env, PATH: `${fakeBin}${path.delimiter}${process.env.PATH}` };
    const result = runCleanup(repo.root, env);
    assert.equal(result.removed.length, 0);
    assert.equal(fs.existsSync(repo.worktree), true);
    assert.equal(result.kept.find((item) => item.path === repo.worktree)?.reason, 'process_scan_failed');
  } finally {
    fs.rmSync(fakeBin, { recursive: true, force: true });
    cleanupAll(repo);
  }
});
