const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { updateSelf } = require('../commands/update');
const { getNpmSelfUpdateSpawnArgs } = require('../utils/update-check');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-update-self-'));
}

function cleanupTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}

test('update --self refuses git checkouts', () => {
  const dir = makeTempDir();
  const messages = [];
  try {
    git(dir, ['init']);

    const result = updateSelf({
      packageRoot: dir,
      log: (message) => messages.push({ level: 'log', message }),
      errorLog: (message) => messages.push({ level: 'error', message }),
      spawnSync: () => {
        throw new Error('spawn should not run for git checkouts');
      },
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'git-checkout');
    assert.deepEqual(messages, [{
      level: 'error',
      message: 'this atris install is a git checkout; use git to update the cli, not atris update --self.',
    }]);
  } finally {
    cleanupTempDir(dir);
  }
});

test('update --self runs npm install -g atris@latest for packaged installs', () => {
  const dir = makeTempDir();
  const calls = [];
  const messages = [];
  try {
    const result = updateSelf({
      packageRoot: dir,
      stdio: 'pipe',
      shell: false,
      log: (message) => messages.push({ level: 'log', message }),
      errorLog: (message) => messages.push({ level: 'error', message }),
      spawnSync: (command, args, options) => {
        calls.push({ command, args, options });
        return { status: 0 };
      },
    });

    const expected = getNpmSelfUpdateSpawnArgs();
    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, expected.command);
    assert.deepEqual(calls[0].args, expected.args);
    assert.equal(calls[0].options.stdio, 'pipe');
    assert.equal(calls[0].options.shell, false);
    assert.deepEqual(
      messages.map((entry) => entry.message),
      [
        'installing latest atris from npm...',
        'atris updated successfully.',
        'run `atris update` in your projects to sync local files.',
      ]
    );
  } finally {
    cleanupTempDir(dir);
  }
});

test('update --self reports install failures with the manual npm command', () => {
  const dir = makeTempDir();
  const messages = [];
  try {
    const result = updateSelf({
      packageRoot: dir,
      stdio: 'pipe',
      shell: false,
      log: (message) => messages.push({ level: 'log', message }),
      errorLog: (message) => messages.push({ level: 'error', message }),
      spawnSync: () => ({ status: 1 }),
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'install-failed');
    assert.equal(result.status, 1);
    assert.deepEqual(
      messages.map((entry) => entry.message),
      [
        'installing latest atris from npm...',
        'update failed. try running manually:',
        '  npm install -g atris@latest',
      ]
    );
  } finally {
    cleanupTempDir(dir);
  }
});
