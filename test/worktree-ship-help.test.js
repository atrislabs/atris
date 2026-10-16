const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runCli } = require('./helpers/workspace-cli');


function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-worktree-ship-help-test-'));
}

function cleanupTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

test('worktree ship --help documents --target without touching the repo', () => {
  const dir = makeTempDir();
  try {
    const res = runCli(['worktree', 'ship', '--help'], dir);
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /--target <ref>/);
    assert.match(res.stdout, /override the default landing target/);
    assert.match(res.stdout, /branch atris-base, else origin default branch/);
    assert.match(res.stdout, /unstaged regenerated adapter files are skipped unless staged first or named in --message/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('worktree help documents ship --target', () => {
  const dir = makeTempDir();
  try {
    const res = runCli(['worktree', '--help'], dir);
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /worktree ship.*--target <ref>/);
    assert.match(res.stdout, /override the default landing target/);
  } finally {
    cleanupTempDir(dir);
  }
});
