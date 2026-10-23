'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execSync } = require('node:child_process');

const { gitSnapshot } = require('../lib/rsi-record');

function createTempDir(prefix = 'rsi-snap-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanEnv(tempHome) {
  process.env.HOME = tempHome;
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('ATRIS_')) {
      delete process.env[key];
    }
  }
}

test('gitSnapshot captures HEAD commit hash and tracked/untracked dirty files', () => {
  const dir = createTempDir('rsi-snap-normal-');
  cleanEnv(dir);
  try {
    execSync('git init -q && git config user.email t@t && git config user.name t', { cwd: dir });
    fs.writeFileSync(path.join(dir, 'tracked.txt'), 'line 1\n');
    execSync('git add tracked.txt && git commit -qm "initial commit"', { cwd: dir });

    const cleanSnap = gitSnapshot(dir);
    assert.ok(typeof cleanSnap.head === 'string' && /^[0-9a-f]{40}$/.test(cleanSnap.head));
    assert.ok(cleanSnap.dirty instanceof Set);
    assert.strictEqual(cleanSnap.dirty.size, 0);

    fs.writeFileSync(path.join(dir, 'tracked.txt'), 'line 2\n');
    fs.writeFileSync(path.join(dir, 'untracked.txt'), 'hello\n');

    const dirtySnap = gitSnapshot(dir);
    assert.strictEqual(dirtySnap.head, cleanSnap.head);
    assert.ok(dirtySnap.dirty instanceof Set);
    assert.strictEqual(dirtySnap.dirty.size, 2);
    assert.strictEqual(dirtySnap.dirty.has('tracked.txt'), true);
    assert.strictEqual(dirtySnap.dirty.has('untracked.txt'), true);

    execSync('git add -A && git commit -qm "second commit"', { cwd: dir });
    const afterSnap = gitSnapshot(dir);
    assert.notStrictEqual(afterSnap.head, cleanSnap.head);
    assert.ok(/^[0-9a-f]{40}$/.test(afterSnap.head));
    assert.strictEqual(afterSnap.dirty.size, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('gitSnapshot handles edge case of repo with no commits and renamed files', () => {
  const dir = createTempDir('rsi-snap-edge-');
  cleanEnv(dir);
  try {
    execSync('git init -q && git config user.email t@t && git config user.name t', { cwd: dir });

    const emptySnap = gitSnapshot(dir);
    assert.strictEqual(emptySnap.head, null);
    assert.ok(emptySnap.dirty instanceof Set);
    assert.strictEqual(emptySnap.dirty.size, 0);

    fs.writeFileSync(path.join(dir, 'init.txt'), 'init\n');
    execSync('git add init.txt', { cwd: dir });
    const stagedSnap = gitSnapshot(dir);
    assert.strictEqual(stagedSnap.head, null);
    assert.strictEqual(stagedSnap.dirty.size, 1);
    assert.strictEqual(stagedSnap.dirty.has('init.txt'), true);

    execSync('git commit -qm "init"', { cwd: dir });
    execSync('git mv init.txt moved.txt', { cwd: dir });
    const renameSnap = gitSnapshot(dir);
    assert.ok(/^[0-9a-f]{40}$/.test(renameSnap.head));
    assert.strictEqual(renameSnap.dirty.size, 1);
    assert.strictEqual(renameSnap.dirty.has('moved.txt'), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('gitSnapshot handles error and non-repo paths gracefully without throwing', () => {
  const dir = createTempDir('rsi-snap-error-');
  cleanEnv(dir);
  try {
    const nonGit = gitSnapshot(dir);
    assert.strictEqual(nonGit.head, null);
    assert.ok(nonGit.dirty instanceof Set);
    assert.strictEqual(nonGit.dirty.size, 0);

    const missing = gitSnapshot(path.join(dir, 'missing-directory'));
    assert.strictEqual(missing.head, null);
    assert.ok(missing.dirty instanceof Set);
    assert.strictEqual(missing.dirty.size, 0);

    const nullSnap = gitSnapshot(null);
    assert.strictEqual(nullSnap.head, null);
    assert.ok(nullSnap.dirty instanceof Set);
    assert.strictEqual(nullSnap.dirty.size, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
