'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildScorecardData } = require('../lib/scorecard');

test('journal rewards in Notes contribute to the endgame total', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-notes-reward-'));
  const atrisDir = path.join(root, 'atris');
  fs.mkdirSync(path.join(atrisDir, 'logs', '2020'), { recursive: true });
  fs.writeFileSync(path.join(atrisDir, 'TODO.md'), '# TODO\n\n## Backlog\n\n## In Progress\n\n## Completed\n');
  fs.writeFileSync(path.join(atrisDir, 'logs', '2020', '2020-01-15.md'),
    '# Journal\n\n## Notes\n- 10:00 AM\n  Reward: 7\n');

  const data = buildScorecardData(atrisDir, {
    slug: 'journal-reward',
    pickedAt: '2020-01-15 09:00',
  });
  assert.strictEqual(data.totalReward, 7);
});
