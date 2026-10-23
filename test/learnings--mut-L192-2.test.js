const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { getStats } = require('../lib/learnings');

test('confidence four is counted as medium', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-confidence-four-'));
  const previousCwd = process.cwd();
  const previousHome = process.env.HOME;
  try {
    process.env.HOME = temporary;
    process.chdir(temporary);
    fs.mkdirSync(path.join(temporary, 'atris'));
    fs.writeFileSync(path.join(temporary, 'atris', 'learnings.jsonl'), JSON.stringify({
      ts: '2025-01-01T00:00:00.000Z',
      type: 'preference',
      key: 'plain-language',
      insight: 'Use plain language in replies',
      confidence: 4,
      source: 'user-stated',
      files: [],
    }) + '\n');
    assert.equal(getStats().medium, 1);
  } finally {
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
