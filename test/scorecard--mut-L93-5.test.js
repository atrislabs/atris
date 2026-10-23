const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildScorecardData } = require('../lib/scorecard');

test('scorecard includes rewards from the picked-at calendar day', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scorecard-start-day-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // Local dates keep the fixture on the same calendar days in every timezone.
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2020, 0, 16, 12).getTime() });
  const atrisDir = path.join(root, 'atris');
  const logsDir = path.join(atrisDir, 'logs', '2020');
  fs.mkdirSync(logsDir, { recursive: true });
  fs.writeFileSync(path.join(atrisDir, 'TODO.md'), '# Tasks\n');
  fs.writeFileSync(path.join(logsDir, '2020-01-15.md'), [
    '## Notes',
    '- 11:59 AM',
    '  Reward: 100',
    '- 12:00 PM',
    '  Reward: 7',
    '',
  ].join('\n'));

  assert.deepStrictEqual(buildScorecardData(atrisDir, {
    slug: 'start-day',
    pickedAt: '2020-01-15 12:00',
  }), {
    slug: 'start-day',
    startDate: '2020-01-15',
    endDate: '2020-01-16',
    tasksShipped: 1,
    tasksAttempted: 1,
    wallClockHours: 24,
    haltRatio: 0,
    totalReward: 7,
    lessonsGenerated: 0,
  });
});
