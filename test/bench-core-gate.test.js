'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const {
  findPython,
  loadTaskSpecs,
  runBench,
} = require('../lib/bench/runner');

const repoRoot = path.resolve(__dirname, '..');
const pack = 'core-v1';

function firstFailureLine(result) {
  const failure = result.failures[0] || 'benchmark case did not pass';
  return String(failure).split(/\r?\n/, 1)[0];
}

if (require.main === module) {
  const taskSpecs = loadTaskSpecs({ repoRoot, pack });
  const pythonCmd = findPython();

  for (const spec of taskSpecs) {
    test(spec.id, { timeout: 60_000 }, async (t) => {
      const { record } = await runBench({
        repoRoot,
        pack,
        taskIds: [spec.id],
        pythonCmd,
        persist: false,
      });
      const [result] = record.tasks;

      if (result.skipped) {
        t.skip(`${result.id} skipped`);
        return;
      }

      assert.equal(result.passed, true, `${result.id}: ${firstFailureLine(result)}`);
    });
  }
}
