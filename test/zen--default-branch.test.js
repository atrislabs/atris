'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { defaultBranch } = require('../lib/zen');

// Every repo lives under one sandbox in tmpdir. Git gets an empty global config
// and a fixed commit identity, so the machine running this file does not matter.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-zen-default-branch-'));
const savedEnv = {};
const gitEnv = {
  HOME: sandbox,
  PATH: process.env.PATH || '/usr/bin:/bin',
  GIT_CONFIG_GLOBAL: path.join(sandbox, 'gitconfig'),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CEILING_DIRECTORIES: os.tmpdir(),
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};
for (const [key, value] of Object.entries(gitEnv)) {
  savedEnv[key] = process.env[key];
  process.env[key] = value;
}

test.after(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(sandbox, { recursive: true, force: true });
});

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30000 });
  assert.strictEqual(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

// A repo with one empty commit on the given branch. No remote refs yet.
function newRepo(branch) {
  const dir = fs.mkdtempSync(path.join(sandbox, 'repo-'));
  git(dir, 'init', '-q', `--initial-branch=${branch}`);
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'first');
  return dir;
}

// Makes refs/remotes/<remote>/<name> point at the current commit, without a real remote.
function setRemoteRef(dir, remote, name) {
  git(dir, 'update-ref', `refs/remotes/${remote}/${name}`, 'HEAD');
}

test('reads the branch that origin/HEAD points at after a real clone', () => {
  const work = newRepo('trunk');
  const origin = path.join(sandbox, 'clone-origin.git');
  git(sandbox, 'init', '-q', '--bare', '--initial-branch=trunk', origin);
  git(work, 'remote', 'add', 'origin', origin);
  git(work, 'push', '-q', 'origin', 'trunk');

  const clone = path.join(sandbox, 'clone');
  git(sandbox, 'clone', '-q', origin, clone);

  assert.strictEqual(defaultBranch(clone, 'origin'), 'trunk');
});

test('origin/HEAD wins over main and master when both exist', () => {
  const work = newRepo('master');
  setRemoteRef(work, 'origin', 'master');
  setRemoteRef(work, 'origin', 'main');
  setRemoteRef(work, 'origin', 'trunk');
  git(work, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk');

  assert.strictEqual(defaultBranch(work, 'origin'), 'trunk');
});

test('without origin/HEAD, main is preferred over master', () => {
  const work = newRepo('master');
  setRemoteRef(work, 'origin', 'master');
  setRemoteRef(work, 'origin', 'main');

  assert.strictEqual(defaultBranch(work, 'origin'), 'main');
});

test('without origin/HEAD or main, master is used', () => {
  const work = newRepo('master');
  setRemoteRef(work, 'origin', 'master');

  assert.strictEqual(defaultBranch(work, 'origin'), 'master');
});

test('returns null when the remote has no main, master, or origin/HEAD', () => {
  const work = newRepo('master');
  // Local branches do not count. Only remote-tracking refs are checked.
  git(work, 'branch', 'main');

  assert.strictEqual(defaultBranch(work, 'origin'), null);
});

test('looks only at the remote it is asked about', () => {
  const work = newRepo('master');
  setRemoteRef(work, 'upstream', 'main');

  assert.strictEqual(defaultBranch(work, 'origin'), null);
  assert.strictEqual(defaultBranch(work, 'upstream'), 'main');
});

test('returns null for a folder that is not a git repository', () => {
  const plain = fs.mkdtempSync(path.join(sandbox, 'plain-'));

  assert.strictEqual(defaultBranch(plain, 'origin'), null);
});

test('returns null for a folder that does not exist', () => {
  const missing = path.join(sandbox, 'does-not-exist');

  assert.strictEqual(defaultBranch(missing, 'origin'), null);
});
