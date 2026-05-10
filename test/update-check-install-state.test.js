const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  inspectInstallGitState,
  formatInstallGitWarning,
} = require('../utils/update-check');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-update-check-'));
}

function cleanupTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}

test('install git state is quiet outside git repos', () => {
  const dir = makeTempDir();
  try {
    const state = inspectInstallGitState(dir);
    assert.equal(state.isGitRepo, false);
    assert.equal(formatInstallGitWarning(state), null);
  } finally {
    cleanupTempDir(dir);
  }
});

test('install git state warns on dirty install checkout', () => {
  const dir = makeTempDir();
  try {
    git(dir, ['init']);
    fs.writeFileSync(path.join(dir, 'local-overlay.txt'), 'dirty\n');

    const state = inspectInstallGitState(dir);
    assert.equal(state.isGitRepo, true);
    assert.equal(state.dirty, true);
    assert.equal(state.dirtyCount, 1);

    const warning = formatInstallGitWarning(state);
    assert.match(warning, /dirty worktree \(1 file\)/);
    assert.match(warning, /npm update may not change the code currently on PATH/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('install git state warns on detached install checkout', () => {
  const dir = makeTempDir();
  try {
    git(dir, ['init']);
    git(dir, ['config', 'user.email', 'test@example.com']);
    git(dir, ['config', 'user.name', 'Atris Test']);
    fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"atris"}\n');
    git(dir, ['add', 'package.json']);
    git(dir, ['commit', '-m', 'seed']);
    git(dir, ['checkout', '--detach', 'HEAD']);

    const state = inspectInstallGitState(dir);
    assert.equal(state.isGitRepo, true);
    assert.equal(state.detached, true);

    const warning = formatInstallGitWarning(state);
    assert.match(warning, /detached HEAD/);
    assert.match(warning, /npm update may not change the code currently on PATH/);
  } finally {
    cleanupTempDir(dir);
  }
});
