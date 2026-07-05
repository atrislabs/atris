'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  BenchInfraError,
  runBench,
} = require('../lib/bench/runner');

function findPython() {
  for (const candidate of ['python3', 'python']) {
    const result = spawnSync(candidate, ['--version'], { encoding: 'utf8' });
    if (!result.error && result.status === 0) {
      return candidate;
    }
  }
  return null;
}

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-bench-runner-test-'));
}

function cleanupTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

function writeTask(tasksDir, filename, source) {
  fs.mkdirSync(tasksDir, { recursive: true });
  fs.writeFileSync(path.join(tasksDir, filename), source, 'utf8');
}

test('runner executes task specs serially', async () => {
  const dir = makeTempDir();
  const tasksDir = path.join(dir, 'tasks');
  const orderFile = path.join(dir, 'order.txt');
  try {
    writeTask(tasksDir, '01-first.js', `
      const fs = require('node:fs');
      module.exports = {
        id: 'first',
        title: 'first',
        async run() {
          fs.appendFileSync(${JSON.stringify(orderFile)}, 'a');
          await new Promise((resolve) => setTimeout(resolve, 20));
        },
      };
    `);
    writeTask(tasksDir, '02-second.js', `
      const fs = require('node:fs');
      module.exports = {
        id: 'second',
        title: 'second',
        async run() {
          fs.appendFileSync(${JSON.stringify(orderFile)}, 'b');
        },
      };
    `);
    const { record, exitCode } = await runBench({ tasksDir, repoRoot: dir, stateRoot: dir });
    assert.equal(exitCode, 0);
    assert.deepEqual(record.passed, ['first', 'second']);
    assert.equal(fs.readFileSync(orderFile, 'utf8'), 'ab');
  } finally {
    cleanupTempDir(dir);
  }
});

test('runner retries once on infra failures only', async () => {
  const dir = makeTempDir();
  const tasksDir = path.join(dir, 'tasks');
  const attemptsFile = path.join(dir, 'attempts.txt');
  try {
    writeTask(tasksDir, '01-flaky.js', `
      const fs = require('node:fs');
      let attempts = 0;
      module.exports = {
        id: 'flaky-infra',
        title: 'flaky infra',
        async run() {
          attempts += 1;
          fs.writeFileSync(${JSON.stringify(attemptsFile)}, String(attempts));
          if (attempts === 1) {
            const err = new Error('temporary timeout');
            err.code = 'ETIMEDOUT';
            throw err;
          }
        },
      };
    `);
    const { record, exitCode } = await runBench({ tasksDir, repoRoot: dir, stateRoot: dir });
    assert.equal(exitCode, 0);
    assert.equal(record.tasks[0].passed, true);
    assert.equal(record.tasks[0].retried, true);
    assert.equal(fs.readFileSync(attemptsFile, 'utf8'), '2');
  } finally {
    cleanupTempDir(dir);
  }
});

test('runner never retries assertion failures', async () => {
  const dir = makeTempDir();
  const tasksDir = path.join(dir, 'tasks');
  const attemptsFile = path.join(dir, 'assert-attempts.txt');
  try {
    writeTask(tasksDir, '01-assertion.js', `
      const assert = require('node:assert/strict');
      const fs = require('node:fs');
      let attempts = 0;
      module.exports = {
        id: 'assertion-failure',
        title: 'assertion failure',
        async run() {
          attempts += 1;
          fs.writeFileSync(${JSON.stringify(attemptsFile)}, String(attempts));
          assert.equal(1, 2);
        },
      };
    `);
    const { record, exitCode } = await runBench({ tasksDir, repoRoot: dir, stateRoot: dir });
    assert.equal(exitCode, 1);
    assert.deepEqual(record.failed, ['assertion-failure']);
    assert.equal(record.tasks[0].retried, false);
    assert.equal(fs.readFileSync(attemptsFile, 'utf8'), '1');
  } finally {
    cleanupTempDir(dir);
  }
});

test('runner records skip semantics without failing the run', async () => {
  const dir = makeTempDir();
  const tasksDir = path.join(dir, 'tasks');
  try {
    writeTask(tasksDir, '01-skip.js', `
      module.exports = {
        id: 'skip-me',
        title: 'skip me',
        async run() {
          return { skipped: true, reason: 'not relevant' };
        },
      };
    `);
    const { record, exitCode } = await runBench({ tasksDir, repoRoot: dir, stateRoot: dir });
    assert.equal(exitCode, 0);
    assert.deepEqual(record.passed, []);
    assert.deepEqual(record.failed, []);
    assert.deepEqual(record.skipped, ['skip-me']);
    assert.equal(record.tasks[0].skipped, true);
    assert.deepEqual(record.tasks[0].failures, []);
    assert.equal(record.summary, '0/0 gate cases passed');
  } finally {
    cleanupTempDir(dir);
  }
});

test('runner skips needsPython tasks when python is unavailable', async () => {
  const dir = makeTempDir();
  const tasksDir = path.join(dir, 'tasks');
  try {
    writeTask(tasksDir, '01-python.js', `
      module.exports = {
        id: 'python-task',
        title: 'python task',
        needsPython: true,
        async run() {
          throw new Error('should not run');
        },
      };
    `);
    const { record, exitCode } = await runBench({ tasksDir, repoRoot: dir, stateRoot: dir, pythonCmd: null });
    assert.equal(exitCode, 0);
    assert.deepEqual(record.skipped, ['python-task']);
    assert.equal(record.tasks[0].passed, false);
    assert.equal(record.tasks[0].skipped, true);
  } finally {
    cleanupTempDir(dir);
  }
});

test('runner appends results, writes baseline pointer, and preserves JSON contract shape', async () => {
  const dir = makeTempDir();
  const tasksDir = path.join(dir, 'tasks');
  try {
    writeTask(tasksDir, '01-pass.js', `
      module.exports = {
        id: 'contract-pass',
        title: 'contract pass',
        async run() {},
      };
    `);
    const { record, exitCode } = await runBench({
      tasksDir,
      repoRoot: dir,
      stateRoot: dir,
      label: 'baseline',
      experiment: 'exp-1',
      updateBaseline: true,
    });
    assert.equal(exitCode, 0);
    assert.deepEqual(Object.keys(record), [
      'schema',
      'label',
      'experiment',
      'started',
      'finished',
      'tasks',
      'passed',
      'failed',
      'skipped',
      'summary',
    ]);
    assert.deepEqual(Object.keys(record.tasks[0]), [
      'id',
      'passed',
      'skipped',
      'failures',
      'duration_ms',
      'retried',
    ]);
    assert.equal(record.schema, 'atris.bench.run.v1');
    assert.equal(record.label, 'baseline');
    assert.equal(record.experiment, 'exp-1');
    assert.equal(record.summary, '1/1 gate cases passed');

    const resultsPath = path.join(dir, '.atris', 'state', 'bench', 'results.jsonl');
    const rows = fs.readFileSync(resultsPath, 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line));
    assert.deepEqual(rows, [record]);

    const baseline = JSON.parse(fs.readFileSync(path.join(dir, '.atris', 'state', 'bench', 'baseline.json'), 'utf8'));
    assert.deepEqual(baseline, record);
  } finally {
    cleanupTempDir(dir);
  }
});

test('runner exposes exit-code classes 0, 1, and 2', async () => {
  const dir = makeTempDir();
  const passDir = path.join(dir, 'pass');
  const failDir = path.join(dir, 'fail');
  try {
    writeTask(passDir, '01-pass.js', `
      module.exports = { id: 'pass', title: 'pass', async run() {} };
    `);
    writeTask(failDir, '01-fail.js', `
      module.exports = { id: 'fail', title: 'fail', async run() { throw new Error('boom'); } };
    `);
    assert.equal((await runBench({ tasksDir: passDir, repoRoot: dir, stateRoot: dir })).exitCode, 0);
    assert.equal((await runBench({ tasksDir: failDir, repoRoot: dir, stateRoot: dir })).exitCode, 1);
    assert.rejects(
      () => runBench({ tasksDir: path.join(dir, 'missing'), repoRoot: dir, stateRoot: dir }),
      (err) => err instanceof BenchInfraError && err.exitCode === 2,
    );
  } finally {
    cleanupTempDir(dir);
  }
});

test('findPython pattern is available for python-gated bench tests', () => {
  const python = findPython();
  assert.ok(python === null || ['python3', 'python'].includes(python));
});
