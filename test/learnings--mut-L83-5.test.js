require('./helpers/clean-temp');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { addLearning, loadLearnings } = require('../lib/learnings');

test('minimum confidence of one is accepted and saved', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-min-confidence-'));
  const previousCwd = process.cwd();
  const previousHome = process.env.HOME;
  try {
    process.env.HOME = home;
    process.chdir(home);
    fs.mkdirSync(path.join(home, 'atris'));
    addLearning({
      type: 'pattern',
      key: 'tentative-pattern',
      insight: 'Validate input before saving.',
      confidence: 1,
      source: 'user-stated',
    });
    assert.strictEqual(loadLearnings()[0]?.confidence, 1);
  } finally {
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
