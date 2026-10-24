'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { proveCheckBeforePublish } = require('../lib/landing-proof');

// Clear any ATRIS_* environment variables and isolate HOME
for (const key of Object.keys(process.env)) {
  if (key.startsWith('ATRIS_')) {
    delete process.env[key];
  }
}
const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-pub-test-home-'));
process.env.HOME = homeDir;

test.after(() => {
  fs.rmSync(homeDir, { recursive: true, force: true });
});

function git(cwd, args) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Proof',
      GIT_AUTHOR_EMAIL: 'proof@example.com',
      GIT_COMMITTER_NAME: 'Proof',
      GIT_COMMITTER_EMAIL: 'proof@example.com',
    },
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')}: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-check-pub-repo-'));
  const root = path.join(dir, 'repo');
  fs.mkdirSync(root);
  git(root, ['init', '-q', '-b', 'master']);
  git(root, ['config', 'user.name', 'Proof']);
  git(root, ['config', 'user.email', 'proof@example.com']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  return { dir, root };
}

function commit(cwd, message, files = {}) {
  for (const [name, body] of Object.entries(files)) {
    const full = path.join(cwd, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }
  git(cwd, ['add', '-A']);
  git(cwd, ['commit', '-q', '--allow-empty', '-m', message]);
  return git(cwd, ['rev-parse', 'HEAD']);
}

test('normal input: returns null when a valid check backs a clean committed change', () => {
  const { dir, root } = makeRepo();
  try {
    const base = commit(root, 'base commit', { 'README.md': '# fixture\n' });
    const work = commit(root, 'feature commit', { 'lib/feature.js': 'module.exports = 42;\n' });

    const result = proveCheckBeforePublish(root, {
      commit: work,
      base,
      verify: 'node lib/feature.js',
    });
    assert.strictEqual(result, null);

    const resultHead = proveCheckBeforePublish(root, {
      base,
      verify: 'node lib/feature.js',
    });
    assert.strictEqual(resultHead, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('edge case: returns empty_diff no_op when commit introduces no changes past base', () => {
  const { dir, root } = makeRepo();
  try {
    const base = commit(root, 'base commit', { 'README.md': '# fixture\n' });

    const result = proveCheckBeforePublish(root, {
      commit: base,
      base,
      verify: 'node --version',
    });
    assert.ok(result);
    assert.strictEqual(result.status, 'no_op');
    assert.strictEqual(result.reason, 'empty_diff');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('edge case: rejects empty or non-falsifying verify check commands', () => {
  const { dir, root } = makeRepo();
  try {
    const base = commit(root, 'base commit', { 'README.md': '# fixture\n' });
    const work = commit(root, 'feature commit', { 'lib/feature.js': 'module.exports = 42;\n' });

    const emptyCheck = proveCheckBeforePublish(root, {
      commit: work,
      base,
      verify: '',
    });
    assert.ok(emptyCheck);
    assert.strictEqual(emptyCheck.status, 'unverified');
    assert.strictEqual(emptyCheck.reason, 'no_check');

    const hollowCheck = proveCheckBeforePublish(root, {
      commit: work,
      base,
      verify: 'git diff --check',
    });
    assert.ok(hollowCheck);
    assert.strictEqual(hollowCheck.status, 'unverified');
    assert.strictEqual(hollowCheck.reason, 'check_cannot_fail');

    const trueCheck = proveCheckBeforePublish(root, {
      commit: work,
      base,
      verify: 'true',
    });
    assert.ok(trueCheck);
    assert.strictEqual(trueCheck.status, 'unverified');
    assert.strictEqual(trueCheck.reason, 'check_cannot_fail');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('edge case: rejects checkout with uncommitted edits to changed files', () => {
  const { dir, root } = makeRepo();
  try {
    const base = commit(root, 'base commit', { 'README.md': '# fixture\n' });
    const work = commit(root, 'feature commit', { 'lib/feature.js': 'module.exports = 42;\n' });

    fs.writeFileSync(path.join(root, 'lib/feature.js'), 'module.exports = 99;\n');

    const result = proveCheckBeforePublish(root, {
      commit: work,
      base,
      verify: 'node lib/feature.js',
    });
    assert.ok(result);
    assert.strictEqual(result.status, 'unverified');
    assert.strictEqual(result.reason, 'checked_uncommitted_files');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('edge case: rejects when working tree does not hold the work commit', () => {
  const { dir, root } = makeRepo();
  try {
    const base = commit(root, 'base commit', { 'README.md': '# fixture\n' });
    const work = commit(root, 'feature commit', { 'lib/feature.js': 'module.exports = 42;\n' });

    git(root, ['checkout', '-q', base]);

    const result = proveCheckBeforePublish(root, {
      commit: work,
      base,
      verify: 'node --version',
    });
    assert.ok(result);
    assert.strictEqual(result.status, 'unverified');
    assert.strictEqual(result.reason, 'check_ran_without_the_work');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('error case: returns not_a_git_checkout when path is not a git repo', () => {
  const notRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-not-git-'));
  try {
    const result = proveCheckBeforePublish(notRepoDir, {
      commit: 'HEAD',
      base: 'HEAD~1',
      verify: 'node --version',
    });
    assert.ok(result);
    assert.strictEqual(result.status, 'unverified');
    assert.strictEqual(result.reason, 'not_a_git_checkout');
  } finally {
    fs.rmSync(notRepoDir, { recursive: true, force: true });
  }
});

test('error case: returns commit_missing when commit or base cannot be resolved', () => {
  const { dir, root } = makeRepo();
  try {
    const base = commit(root, 'base commit', { 'README.md': '# fixture\n' });

    const resultMissingBase = proveCheckBeforePublish(root, {
      commit: base,
      base: 'deadbeef00000000000000000000000000000000',
      verify: 'node --version',
    });
    assert.ok(resultMissingBase);
    assert.strictEqual(resultMissingBase.status, 'unverified');
    assert.strictEqual(resultMissingBase.reason, 'commit_missing');

    const resultMissingCommit = proveCheckBeforePublish(root, {
      commit: 'deadbeef00000000000000000000000000000000',
      base,
      verify: 'node --version',
    });
    assert.ok(resultMissingCommit);
    assert.strictEqual(resultMissingCommit.status, 'unverified');
    assert.strictEqual(resultMissingCommit.reason, 'commit_missing');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
