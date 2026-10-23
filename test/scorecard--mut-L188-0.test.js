'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildScorecardData } = require('../lib/scorecard');

test('an in-progress endgame task counts as attempted with no completed tasks or journal', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-attempted-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'TODO.md'), [
    '# TODO',
    '',
    '## Backlog',
    '',
    '## In Progress',
    '- **T1:** Deliver the release [endgame]',
    '',
    '## Completed',
    '',
  ].join('\n'));

  const data = buildScorecardData(root, {
    slug: 'release',
    pickedAt: '2025-01-15 12:00',
  });

  assert.strictEqual(data.tasksAttempted, 1);
});
