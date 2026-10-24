'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildScorecardData } = require('../lib/scorecard');

test('morning reward after the endgame was picked is included', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-morning-reward-'));
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  try {
    const atrisDir = path.join(root, 'atris');
    const logs = path.join(atrisDir, 'logs', '2025');
    fs.mkdirSync(logs, { recursive: true });
    fs.writeFileSync(path.join(atrisDir, 'TODO.md'), '# TODO\n\n## Completed\n');
    fs.writeFileSync(path.join(logs, '2025-01-15.md'), '# Log\n\n## Notes\n\n- 9:30 am\n  I planned, built, and reviewed "morning task".\n  Reward: 6\n');
    const data = buildScorecardData(atrisDir, { slug: 'morning', pickedAt: '2025-01-15 09:00' });
    assert.strictEqual(data.totalReward, 6);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
