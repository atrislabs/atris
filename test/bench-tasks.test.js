'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runBench } = require('../lib/bench/runner');

const repoRoot = path.resolve(__dirname, '..');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-bench-tasks-test-'));
}

function cleanupTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

test('real core-v1 smoke tasks pass through the runner', async () => {
  const dir = makeTempDir();
  try {
    const { record, exitCode } = await runBench({
      repoRoot,
      stateRoot: dir,
      taskIds: [
        'help-no-workspace-safety',
        'operator-ready-gating',
        'lesson-typed-roundtrip',
      ],
    });
    assert.equal(exitCode, 0, JSON.stringify(record, null, 2));
    assert.deepEqual(record.failed, []);
    assert.deepEqual(record.skipped, []);
    assert.deepEqual(record.passed, [
      'help-no-workspace-safety',
      'operator-ready-gating',
      'lesson-typed-roundtrip',
    ]);
    assert.equal(record.summary, '3/3 gate cases passed');
  } finally {
    cleanupTempDir(dir);
  }
});
