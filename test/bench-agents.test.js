'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runBench } = require('../lib/bench/runner');

const repoRoot = path.resolve(__dirname, '..');
const agentsPackDir = path.join(repoRoot, 'atris', 'benchmarks', 'agents-v1');

function taskIdsFromDirectories() {
  return fs.readdirSync(agentsPackDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) => fs.existsSync(path.join(agentsPackDir, entry.name, 'check.js')))
    .map((entry) => {
      const checkPath = path.join(agentsPackDir, entry.name, 'check.js');
      delete require.cache[require.resolve(checkPath)];
      return require(checkPath).id;
    });
}

test('agents-v1 tasks fail under null and pass under solution', async () => {
  const taskIds = taskIdsFromDirectories();
  assert.deepEqual(taskIds, [
    'find-the-bug-line',
    'fix-failing-test',
    'no-commit-rule',
    'add-json-flag',
    'merge-conflict',
  ]);

  for (const id of taskIds) {
    const nullStateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-bench-agents-null-'));
    try {
      const { record, exitCode } = await runBench({
        repoRoot,
        pack: 'agents-v1',
        engine: 'null',
        taskIds: [id],
        stateRoot: nullStateRoot,
        persist: false,
      });
      assert.equal(exitCode, 1, `${id} unexpectedly passed under null:\n${JSON.stringify(record, null, 2)}`);
      assert.deepEqual(record.failed, [id]);
      assert.deepEqual(record.passed, []);
      assert.deepEqual(record.skipped, []);
      assert.equal(record.tasks[0].skipped, false);
    } finally {
      fs.rmSync(nullStateRoot, { recursive: true, force: true });
    }

    const solutionStateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-bench-agents-solution-'));
    try {
      const { record, exitCode } = await runBench({
        repoRoot,
        pack: 'agents-v1',
        engine: 'solution',
        taskIds: [id],
        stateRoot: solutionStateRoot,
        persist: false,
      });
      assert.equal(exitCode, 0, `${id} failed under solution:\n${JSON.stringify(record, null, 2)}`);
      assert.deepEqual(record.passed, [id]);
      assert.deepEqual(record.failed, []);
      assert.deepEqual(record.skipped, []);
    } finally {
      fs.rmSync(solutionStateRoot, { recursive: true, force: true });
    }
  }
});
