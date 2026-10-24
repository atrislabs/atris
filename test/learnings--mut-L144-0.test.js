require('./helpers/clean-temp');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { addLearning, findPruneTargets } = require('../lib/learnings');

test('distinct learning types can share a key without being flagged as contradictions', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-prune-types-'));
  const originalCwd = process.cwd();
  const originalHome = process.env.HOME;
  try {
    process.env.HOME = temp;
    process.chdir(temp);
    fs.mkdirSync(path.join(temp, 'atris'));
    addLearning({
      type: 'pattern', key: 'validation', insight: 'Validate input at the API boundary',
      confidence: 8, source: 'user-stated',
    });
    addLearning({
      type: 'tool', key: 'validation', insight: 'Use node:test for validation checks',
      confidence: 7, source: 'user-stated',
    });

    assert.strictEqual(findPruneTargets().contradictions.length, 0);
  } finally {
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  }
});
