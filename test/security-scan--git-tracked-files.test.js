'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { gitTrackedFiles } = require('../lib/security-scan');

// git inherits this process env, so drop GIT_* vars that could redirect the
// fixture repos (GIT_DIR, GIT_WORK_TREE) under a polluted environment.
function gitEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith('GIT_')) env[k] = v;
  }
  return env;
}

const gitAvailable = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore', env: gitEnv() });
    return true;
  } catch {
    return false;
  }
})();

function git(dir, args) {
  execFileSync('git', args, { cwd: dir, stdio: 'ignore', env: gitEnv() });
}

function initRepo(dir) {
  git(dir, ['init', '-q']);
}

function commitAll(dir, message) {
  git(dir, ['add', '-A']);
  git(dir, [
    '-c', 'user.name=security-scan-test',
    '-c', 'user.email=security-scan-test@example.com',
    '-c', 'commit.gpgsign=false',
    'commit', '-q', '-m', message,
  ]);
}

// when git is missing every call must return null; still a real contract
function assertNullOr(dir, options, check) {
  const res = gitTrackedFiles(dir, options);
  if (!gitAvailable) {
    assert.equal(res, null);
    return null;
  }
  check(res);
  return res;
}

test('gitTrackedFiles lists index files and skips untracked files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-sec-git-tracked-'));
  try {
    initRepo(dir);
    fs.mkdirSync(path.join(dir, 'lib'));
    fs.writeFileSync(path.join(dir, 'app.js'), 'module.exports = 1;\n');
    fs.writeFileSync(path.join(dir, 'lib', 'util.js'), 'module.exports = 2;\n');
    fs.writeFileSync(path.join(dir, 'scratch.tmp'), 'not added\n');
    git(dir, ['add', 'app.js', 'lib/util.js']);

    const res = assertNullOr(dir, undefined, (files) => {
      assert.deepEqual(files, ['app.js', 'lib/util.js']);
      assert.ok(!files.includes('scratch.tmp'), 'untracked file must not appear');
    });
    if (res) assert.ok(res.every((f) => typeof f === 'string' && f.length > 0));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('gitTrackedFiles returns an empty array for a repo with nothing in the index', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-sec-git-empty-'));
  try {
    initRepo(dir);
    fs.writeFileSync(path.join(dir, 'untracked.js'), 'module.exports = 1;\n');
    assertNullOr(dir, undefined, (files) => assert.deepEqual(files, []));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('gitTrackedFiles with staged lists staged adds and edits but not staged deletes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-sec-git-staged-'));
  try {
    initRepo(dir);
    fs.writeFileSync(path.join(dir, 'base.js'), 'module.exports = 1;\n');
    fs.writeFileSync(path.join(dir, 'doomed.js'), 'module.exports = 0;\n');
    commitAll(dir, 'base');

    fs.writeFileSync(path.join(dir, 'new.js'), 'module.exports = 3;\n');
    git(dir, ['add', 'new.js']);
    git(dir, ['rm', '-q', 'doomed.js']);

    const staged = assertNullOr(dir, { staged: true }, (files) => {
      assert.deepEqual(files, ['new.js']);
      assert.ok(!files.includes('doomed.js'), 'staged deletion is filtered by --diff-filter=ACM');
      assert.ok(!files.includes('base.js'), 'unchanged file has no staged diff');
    });
    if (staged) {
      assert.deepEqual(gitTrackedFiles(dir).sort(), ['base.js', 'new.js']);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('gitTrackedFiles returns null outside a git repo', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-sec-git-none-'));
  try {
    fs.writeFileSync(path.join(dir, 'app.js'), 'module.exports = 1;\n');
    assert.equal(gitTrackedFiles(dir), null);
    assert.equal(gitTrackedFiles(dir, { staged: true }), null);
    assert.equal(gitTrackedFiles(path.join(dir, 'missing-subdir')), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
