require('./helpers/clean-temp');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { getStats } = require('../lib/learnings');

test('statistics exclude a learning whose confidence has fully decayed', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-decayed-learning-'));
  const previousCwd = process.cwd();
  const previousHome = process.env.HOME;
  try {
    process.env.HOME = root;
    process.chdir(root);
    fs.mkdirSync(path.join(root, 'atris'));
    fs.writeFileSync(path.join(root, 'atris', 'learnings.jsonl'), JSON.stringify({
      ts: '2000-01-01T00:00:00.000Z',
      type: 'pattern',
      key: 'expired-pattern',
      insight: 'Use the previous API envelope.',
      confidence: 1,
      source: 'observed',
      files: [],
    }) + '\n');
    assert.equal(getStats().total, 0);
  } finally {
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
