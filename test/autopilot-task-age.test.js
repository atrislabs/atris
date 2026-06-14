'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { getTaskAgeDays } = require('../commands/autopilot');

// Date N days before now, as the YYYY-MM-DD the helper extracts.
const isoDaysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

test('getTaskAgeDays derives age from the date in task.claimed', () => {
  const age = getTaskAgeDays({ claimed: `claimed by alice ${isoDaysAgo(30)}` });
  // range tolerates the UTC-date vs local-now boundary (never flaky at midnight)
  assert.ok(age >= 29 && age <= 31, `expected ~30, got ${age}`);
});

test('getTaskAgeDays returns 0 for a task claimed today', () => {
  assert.equal(getTaskAgeDays({ claimed: isoDaysAgo(0) }), 0);
});

test('getTaskAgeDays returns 0 when claimed has no date and no endgame fallback', () => {
  assert.equal(getTaskAgeDays({ claimed: 'no date in here' }), 0);
  assert.equal(getTaskAgeDays({}), 0);
});

test('getTaskAgeDays falls back to the endgame **Picked:** date for endgame tasks', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-task-age-'));
  try {
    const todoPath = path.join(dir, 'TODO.md');
    fs.writeFileSync(todoPath, `# TODO\n\n## Endgame\n**Picked:** ${isoDaysAgo(10)}\n`);
    const age = getTaskAgeDays({ tag: 'endgame' }, todoPath);
    assert.ok(age >= 9 && age <= 11, `expected ~10, got ${age}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('getTaskAgeDays ignores the endgame fallback for non-endgame tasks', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-task-age-'));
  try {
    const todoPath = path.join(dir, 'TODO.md');
    fs.writeFileSync(todoPath, `## Endgame\n**Picked:** ${isoDaysAgo(10)}\n`);
    // no claimed date + tag !== endgame → 0, even though the file has a Picked date
    assert.equal(getTaskAgeDays({ tag: 'reactive' }, todoPath), 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
