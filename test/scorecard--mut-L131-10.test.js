'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildScorecardData } = require('../lib/scorecard');

test('journal reward after the first note timestamp contributes to the total', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-reward-note-'));
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  try {
    fs.mkdirSync(path.join(root, 'logs', '2001'), { recursive: true });
    fs.writeFileSync(path.join(root, 'TODO.md'), '# TODO\n\n## Completed\n');
    fs.writeFileSync(path.join(root, 'logs', '2001', '2001-02-03.md'),
      '# Journal\n\n## Notes\n- 10:30\n  Reward: 7\n');

    const result = buildScorecardData(root, {
      slug: 'journal-rewards',
      pickedAt: '2001-02-03 10:00',
    });
    assert.strictEqual(result.totalReward, 7);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
