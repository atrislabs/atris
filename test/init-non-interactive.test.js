const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');
const INIT_TIMEOUT_MS = 15000;
const SKIP_HINT = "context gatherer skipped (non-interactive). run 'atris plan' when you're ready.";

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-init-non-interactive-'));
}

function cleanupTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function runInit(args, { cwd, input, env } = {}) {
  const result = spawnSync(process.execPath, [cliPath, 'init', ...args], {
    cwd,
    input,
    encoding: 'utf8',
    timeout: INIT_TIMEOUT_MS,
    env: {
      ...process.env,
      ATRIS_SKIP_UPDATE_CHECK: '1',
      ...(env || {}),
    },
  });

  if (result.error && result.error.code === 'ETIMEDOUT') {
    assert.fail(`init hung past ${INIT_TIMEOUT_MS}ms (args: ${args.join(' ') || '(none)'})`);
  }

  if (result.error) {
    throw result.error;
  }

  return result;
}

test('init --yes exits without hanging and skips context gatherer', () => {
  const dir = makeTempDir();
  try {
    const res = runInit(['--yes'], { cwd: dir });
    assert.equal(res.status, 0, `stdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
    assert.ok(res.stdout.includes(SKIP_HINT));
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'atris.md')));
  } finally {
    cleanupTempDir(dir);
  }
});

test('init -y exits without hanging and skips context gatherer', () => {
  const dir = makeTempDir();
  try {
    const res = runInit(['-y'], { cwd: dir });
    assert.equal(res.status, 0, `stdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
    assert.ok(res.stdout.includes(SKIP_HINT));
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'atris.md')));
  } finally {
    cleanupTempDir(dir);
  }
});

test('init with piped stdin exits without hanging', () => {
  const dir = makeTempDir();
  try {
    const res = runInit([], { cwd: dir, input: '' });
    assert.equal(res.status, 0, `stdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
    assert.ok(res.stdout.includes(SKIP_HINT));
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'atris.md')));
  } finally {
    cleanupTempDir(dir);
  }
});

test('init with ATRIS_NO_INTERACTIVE skips context gatherer', () => {
  const dir = makeTempDir();
  try {
    const res = runInit([], { cwd: dir, env: { ATRIS_NO_INTERACTIVE: '1' } });
    assert.equal(res.status, 0, `stdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
    assert.ok(res.stdout.includes(SKIP_HINT));
  } finally {
    cleanupTempDir(dir);
  }
});
