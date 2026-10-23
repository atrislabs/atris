'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const learn = require('../commands/learn');

test('learn prune reports an empty learning store as healthy', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-learn-prune-'));
  const originalCwd = process.cwd();
  const originalLog = console.log;
  const lines = [];

  try {
    fs.mkdirSync(path.join(cwd, 'atris'));
    fs.writeFileSync(path.join(cwd, 'atris', 'learnings.jsonl'), '');
    process.chdir(cwd);
    console.log = (line) => lines.push(line);

    learn('prune');

    assert.deepEqual(lines, [
      '',
      '  ✓ All learnings are healthy. No stale entries or contradictions.',
      '',
    ]);
  } finally {
    console.log = originalLog;
    process.chdir(originalCwd);
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
