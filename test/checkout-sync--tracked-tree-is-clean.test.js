'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { trackedTreeIsClean } = require('../lib/checkout-sync');

function withRepository(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'checkout-sync-clean-'));
  const savedEnv = { ...process.env };
  try {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('GIT_')) delete process.env[key];
    }
    process.env.HOME = root;
    process.env.XDG_CONFIG_HOME = root;
    process.env.GIT_CONFIG_NOSYSTEM = '1';
    process.env.GIT_CONFIG_GLOBAL = path.join(root, 'absent-gitconfig');
    process.env.GIT_AUTHOR_DATE = '2000-01-01T00:00:00Z';
    process.env.GIT_COMMITTER_DATE = '2000-01-01T00:00:00Z';
    const repo = path.join(root, 'repo');
    fs.mkdirSync(repo);
    function git(...args) {
      const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
      assert.strictEqual(result.status, 0, result.stderr || String(result.error));
    }
    git('init', '--quiet');
    const file = path.join(repo, 'tracked.txt');
    function commitFile() {
      fs.writeFileSync(file, 'original\n');
      git('add', '--', 'tracked.txt');
      git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
        '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'fixture');
    }
    run({ root, repo, file, git, commitFile });
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key];
    }
    Object.assign(process.env, savedEnv);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('clean tracked files remain clean when an untracked file is present', () => {
  withRepository(({ repo, commitFile }) => {
    commitFile();
    assert.strictEqual(trackedTreeIsClean(repo), true);
    fs.writeFileSync(path.join(repo, 'untracked.txt'), 'untracked\n');
    assert.strictEqual(trackedTreeIsClean(repo), true);
  });
});

test('unstaged modifications and deletions make the tracked tree dirty', () => {
  withRepository(({ repo, file, commitFile }) => {
    commitFile();
    fs.writeFileSync(file, 'changed\n');
    assert.strictEqual(trackedTreeIsClean(repo), false);
    fs.writeFileSync(file, 'original\n');
    assert.strictEqual(trackedTreeIsClean(repo), true);
    fs.unlinkSync(file);
    assert.strictEqual(trackedTreeIsClean(repo), false);
  });
});

test('staged changes are dirty even when the working file matches the index', () => {
  withRepository(({ repo, file, git, commitFile }) => {
    commitFile();
    fs.writeFileSync(file, 'staged\n');
    git('add', '--', 'tracked.txt');
    assert.strictEqual(trackedTreeIsClean(repo), false);
  });
});

test('an empty repository is clean until its first file is staged', () => {
  withRepository(({ repo, file, git }) => {
    assert.strictEqual(trackedTreeIsClean(repo), true);
    fs.writeFileSync(file, 'first\n');
    git('add', '--', 'tracked.txt');
    assert.strictEqual(trackedTreeIsClean(repo), false);
  });
});

test('a non-repository directory or missing directory returns false', () => {
  withRepository(({ root }) => {
    assert.strictEqual(trackedTreeIsClean(root), false);
    assert.strictEqual(trackedTreeIsClean(path.join(root, 'missing')), false);
  });
});
