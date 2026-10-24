require('./helpers/clean-temp');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { getStats } = require('../lib/learnings');

test('average confidence is zero with no saved entries', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-empty-stats-'));
  const originalCwd = process.cwd();
  const originalHome = process.env.HOME;
  try {
    process.env.HOME = tempDir;
    process.chdir(tempDir);
    fs.mkdirSync(path.join(tempDir, 'atris'));
    assert.strictEqual(getStats().avgConfidence, 0);
  } finally {
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  }
});
