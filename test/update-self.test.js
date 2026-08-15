const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { updateSelf } = require('../commands/update');
const { autoUpdate, getNpmSelfUpdateSpawnArgs } = require('../utils/update-check');

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

test('autoUpdate with injected spawn starts detached npm install -g atris@latest', () => {
  const dir = makeTempDir();
  const calls = [];
  const messages = [];
  try {
    const started = autoUpdate(
      { installed: '1.0.0', latest: '2.0.0', needsUpdate: true },
      {
        packageRoot: dir,
        env: {},
        installState: { isGitRepo: false, root: dir },
        recentlyStarted: () => false,
        markStarted: (version) => calls.push({ markStarted: version }),
        log: (message) => messages.push(message),
        spawn: (command, args, options) => {
          calls.push({ command, args, options });
          return { on: () => {}, unref: () => {} };
        },
      }
    );

    const expected = getNpmSelfUpdateSpawnArgs();
    assert.equal(started, true);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].command, expected.command);
    assert.deepEqual(calls[0].args, expected.args);
    assert.equal(calls[0].options.detached, true);
    assert.equal(calls[0].options.stdio, 'ignore');
    assert.deepEqual(calls[1], { markStarted: '2.0.0' });
    assert.equal(messages.length, 1);
  } finally {
    cleanupTempDir(dir);
  }
});

test('autoUpdate returns false without spawning when ATRIS_AUTO_UPDATE=off', () => {
  const dir = makeTempDir();
  const calls = [];
  try {
    const started = autoUpdate(
      { installed: '1.0.0', latest: '2.0.0', needsUpdate: true },
      {
        packageRoot: dir,
        env: { ATRIS_AUTO_UPDATE: 'off' },
        installState: { isGitRepo: false, root: dir },
        recentlyStarted: () => false,
        markStarted: () => calls.push({ markStarted: true }),
        log: (message) => calls.push({ message }),
        spawn: (command, args, options) => {
          calls.push({ command, args, options });
          return { on: () => {}, unref: () => {} };
        },
      }
    );

    assert.equal(started, false);
    assert.deepEqual(calls, []);
  } finally {
    cleanupTempDir(dir);
  }
});

test('autoUpdate returns false when recentlyStarted returns true', () => {
  const dir = makeTempDir();
  const calls = [];
  try {
    const started = autoUpdate(
      { installed: '1.0.0', latest: '2.0.0', needsUpdate: true },
      {
        packageRoot: dir,
        env: {},
        installState: { isGitRepo: false, root: dir },
        recentlyStarted: () => true,
        markStarted: () => calls.push({ markStarted: true }),
        log: (message) => calls.push({ message }),
        spawn: (command, args, options) => {
          calls.push({ command, args, options });
          return { on: () => {}, unref: () => {} };
        },
      }
    );

    assert.equal(started, false);
    assert.deepEqual(calls, []);
  } finally {
    cleanupTempDir(dir);
  }
});
