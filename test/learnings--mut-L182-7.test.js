require('./helpers/clean-temp');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { getStats } = require('../lib/learnings');

test('statistics count saved entries sharing a source', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-source-count-'));
  const previousCwd = process.cwd();
  const previousHome = process.env.HOME;
  try {
    process.env.HOME = home;
    process.chdir(home);
    fs.mkdirSync(path.join(home, 'atris'));
    const entries = ['validate-input', 'atomic-writes'].map(key => ({
      ts: '2025-01-01T00:00:00.000Z',
      type: 'pattern',
      key,
      insight: 'Validate changes before saving.',
      confidence: 8,
      source: 'user-stated',
      files: [],
    }));
    fs.writeFileSync(path.join(home, 'atris', 'learnings.jsonl'),
      entries.map(entry => JSON.stringify(entry)).join('\n') + '\n');
    assert.strictEqual(getStats().bySource['user-stated'], 2);
  } finally {
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
