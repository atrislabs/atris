const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

function findPython() {
  for (const candidate of ['python3', 'python']) {
    const result = spawnSync(candidate, ['--version'], { encoding: 'utf8' });
    if (!result.error && result.status === 0) {
      return candidate;
    }
  }
  return null;
}

const pythonCmd = findPython();

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-experiments-test-'));
}

function cleanupTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function runCli(args, { cwd, input } = {}) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    input,
    encoding: 'utf8',
    timeout: 20000,
    env: {
      ...process.env,
      ATRIS_SKIP_UPDATE_CHECK: '1',
      ...(pythonCmd ? { ATRIS_EXPERIMENTS_PYTHON: pythonCmd } : {}),
    },
  });

  if (result.error) throw result.error;
  return result;
}

function initWorkspace(dir) {
  const result = runCli(['init'], { cwd: dir, input: '\n' });
  assert.equal(result.status, 0, result.stderr);
}

test('init creates experiments framework assets', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);

    const experimentsDir = path.join(dir, 'atris', 'experiments');
    assert.ok(fs.existsSync(path.join(experimentsDir, 'README.md')));
    assert.ok(fs.existsSync(path.join(experimentsDir, 'validate.py')));
    assert.ok(fs.existsSync(path.join(experimentsDir, '_template', 'pack', 'program.md')));
    assert.ok(fs.existsSync(path.join(experimentsDir, '_examples', 'smoke-keep-revert', 'loop.py')));
  } finally {
    cleanupTempDir(dir);
  }
});

test('experiments init scaffolds a new pack', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);

    const result = runCli(['experiments', 'init', 'self-heal'], { cwd: dir });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Created atris\/experiments\/self-heal/);

    const packDir = path.join(dir, 'atris', 'experiments', 'self-heal');
    assert.ok(fs.existsSync(path.join(packDir, 'program.md')));
    assert.ok(fs.existsSync(path.join(packDir, 'measure.py')));
    assert.ok(fs.existsSync(path.join(packDir, 'loop.py')));
    assert.ok(fs.existsSync(path.join(packDir, 'results.tsv')));
  } finally {
    cleanupTempDir(dir);
  }
});

test('experiments validate passes on fresh scaffold', { skip: !pythonCmd }, () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    runCli(['experiments', 'init', 'self-heal'], { cwd: dir });

    const result = runCli(['experiments', 'validate'], { cwd: dir });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /PASS:/);
    assert.match(result.stdout, /self-heal/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('experiments validate accepts a single pack path', { skip: !pythonCmd }, () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    runCli(['experiments', 'init', 'self-heal'], { cwd: dir });

    const result = runCli(['experiments', 'validate', 'self-heal'], { cwd: dir });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /PASS:/);
    assert.match(result.stdout, /self-heal/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('experiments benchmark runs validate and runtime checks', { skip: !pythonCmd }, () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);

    const result = runCli(['experiments', 'benchmark'], { cwd: dir });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /PASS benchmark_validate/);
    assert.match(result.stdout, /PASS benchmark_runtime/);
  } finally {
    cleanupTempDir(dir);
  }
});
