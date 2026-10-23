'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildScorecardData } = require('../lib/scorecard');

test('a rewarded journal entry contributes its reward with no completed tasks', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-reward-entry-'));
  try {
    const atrisDir = path.join(root, 'atris');
    const logsDir = path.join(atrisDir, 'logs', '2020');
    fs.mkdirSync(logsDir, { recursive: true });
    fs.writeFileSync(path.join(atrisDir, 'TODO.md'), '# TODO\n\n## Backlog\n\n## In Progress\n\n## Completed\n');
    fs.writeFileSync(path.join(logsDir, '2020-01-15.md'), '# Journal\n\n## Notes\n- 10:00\n  Reward: 6\n');

    const data = buildScorecardData(atrisDir, {
      slug: 'journal-reward',
      pickedAt: '2020-01-15 09:00',
    });
    assert.strictEqual(data.totalReward, 6);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
