'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildScorecardData } = require('../lib/scorecard');

test('tasksShipped counts completed tasks with endgame tag', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'endgame-shipped-'));
  try {
    fs.writeFileSync(
      path.join(dir, 'TODO.md'),
      '## Completed\n\n- **T-1:** [endgame] shipped item\n'
    );
    const data = buildScorecardData(dir, { slug: 'test-slug', pickedAt: '2026-01-01 00:00' });
    assert.strictEqual(data.tasksShipped, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
