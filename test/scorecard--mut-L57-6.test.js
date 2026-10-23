'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildScorecardData } = require('../lib/scorecard');

test('morning journal work before an afternoon start is not shipped work', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-morning-start-'));
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  try {
    fs.mkdirSync(path.join(root, 'logs', '2001'), { recursive: true });
    fs.writeFileSync(path.join(root, 'TODO.md'), '# TODO\n\n## Completed\n');
    fs.writeFileSync(path.join(root, 'logs', '2001', '2001-02-03.md'),
      '# Journal\n\n## Notes\n- 9:30 AM\n  Reward: 7\n');

    const result = buildScorecardData(root, {
      slug: 'afternoon-start',
      pickedAt: '2001-02-03 14:00',
    });
    assert.strictEqual(result.tasksShipped, 0);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
