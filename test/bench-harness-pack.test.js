'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadTaskSpecs, runBench } = require('../lib/bench/runner');

const REPO_ROOT = path.resolve(__dirname, '..');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-bench-harness-test-'));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

function writeAgentTask(root, checkSource) {
  const taskDir = path.join(root, 'tasks', '01-recording');
  fs.mkdirSync(path.join(taskDir, 'fixture'), { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'fixture', 'seed.txt'), 'fixture\n', 'utf8');
  fs.writeFileSync(path.join(taskDir, 'prompt.md'), 'record the engine output for this benchmark task.\n', 'utf8');
  fs.writeFileSync(path.join(taskDir, 'solution.sh'), '#!/bin/sh\nexit 0\n', 'utf8');
  fs.writeFileSync(path.join(taskDir, 'check.js'), checkSource, 'utf8');
  return path.join(root, 'tasks');
}

test('harness-v1 loads three agent tasks', () => {
  const specs = loadTaskSpecs({ repoRoot: REPO_ROOT, pack: 'harness-v1' });
  assert.deepEqual(specs.map((spec) => spec.id), [
    'what-next',
    'free-model',
    'keep-going-name-it',
  ]);
  assert.deepEqual(specs.map((spec) => spec.kind), ['agent', 'agent', 'agent']);
});

test('harness-v1 solution engine satisfies all three checks', async () => {
  const stateRoot = makeTempDir();
  try {
    const result = await runBench({
      repoRoot: REPO_ROOT,
      pack: 'harness-v1',
      engine: 'solution',
      stateRoot,
    });

    assert.equal(result.exitCode, 0, result.record.tasks.flatMap((task) => task.failures).join('\n'));
    assert.deepEqual(result.record.passed, ['what-next', 'free-model', 'keep-going-name-it']);
    assert.deepEqual(result.record.failed, []);
  } finally {
    cleanup(stateRoot);
  }
});

test('harness-v1 null engine fails all three checks', async () => {
  const stateRoot = makeTempDir();
  try {
    const result = await runBench({
      repoRoot: REPO_ROOT,
      pack: 'harness-v1',
      engine: 'null',
      stateRoot,
    });

    assert.equal(result.exitCode, 1);
    assert.deepEqual(result.record.passed, []);
    assert.deepEqual(result.record.failed, ['what-next', 'free-model', 'keep-going-name-it']);
  } finally {
    cleanup(stateRoot);
  }
});

test('agent checks receive the engine transcript from a recording engine', async () => {
  const dir = makeTempDir();
  try {
    const tasksDir = writeAgentTask(dir, `
      const assert = require('node:assert/strict');
      module.exports = {
        id: 'recording',
        title: 'record engine output',
        category: 'harness',
        check(ctx) {
          assert.deepEqual(ctx.engineResult, {
            status: 0,
            stdout: 'recorded output\\n',
            stderr: 'recorded warning\\n',
            timedOut: false,
          });
        },
      };
    `);
    const engineAdapter = {
      available() {
        return { available: true, reason: 'available' };
      },
      run() {
        return { status: 0, stdout: 'recorded output\n', stderr: 'recorded warning\n' };
      },
    };

    const result = await runBench({
      repoRoot: dir,
      tasksDir,
      engine: 'null',
      engineAdapter,
      stateRoot: dir,
      persist: false,
    });

    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.record.passed, ['recording']);
  } finally {
    cleanup(dir);
  }
});

test('agent task path starts with a working shim for this checkout', async () => {
  const dir = makeTempDir();
  try {
    const tasksDir = writeAgentTask(dir, `
      const assert = require('node:assert/strict');
      const fs = require('node:fs');
      const path = require('node:path');
      module.exports = {
        id: 'recording',
        title: 'run the checkout cli shim',
        category: 'harness',
        check(ctx) {
          const resolved = ctx.run('/bin/sh', ['-c', 'command -v atris']);
          assert.equal(resolved.status, 0, resolved.stderr || resolved.stdout);
          const shimPath = resolved.stdout.trim();
          assert.equal(shimPath, path.join(ctx.env.HOME, 'bin', 'atris'));
          assert.equal(fs.readFileSync(shimPath, 'utf8').includes(ctx.cliPath), true);
          const version = ctx.run('atris', ['--version']);
          assert.equal(version.status, 0, version.stderr || version.stdout);
          assert.match(version.stdout, /^atris v?\\d+\\.\\d+\\.\\d+/);
        },
      };
    `);

    const result = await runBench({
      repoRoot: REPO_ROOT,
      tasksDir,
      engine: 'null',
      stateRoot: dir,
      persist: false,
    });

    assert.equal(result.exitCode, 0, result.record.tasks[0].failures.join('\n'));
  } finally {
    cleanup(dir);
  }
});
