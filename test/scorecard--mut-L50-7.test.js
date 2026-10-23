const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildScorecardData } = require('../lib/scorecard');

test('scorecard counts journal rewards at or after the picked time', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scorecard-time-'));
  const RealDate = global.Date;
  const now = new RealDate(2020, 0, 2, 15).getTime();
  try {
    global.Date = class extends RealDate {
      constructor(...args) {
        super(...(args.length ? args : [now]));
      }
      static now() { return now; }
    };
    const atrisDir = path.join(root, 'atris');
    const logsDir = path.join(atrisDir, 'logs', '2020');
    fs.mkdirSync(logsDir, { recursive: true });
    fs.writeFileSync(path.join(atrisDir, 'TODO.md'), '# Tasks\n');
    fs.writeFileSync(path.join(logsDir, '2020-01-02.md'), [
      '## Notes',
      '- 11:59 AM',
      '  Reward: 99',
      '- 12:00 PM',
      '  Reward: 7',
      '- 2:30 PM',
      '  Reward: -2',
      '  verify failed',
      '',
    ].join('\n'));

    assert.deepStrictEqual(buildScorecardData(atrisDir, {
      slug: 'journal-rewards',
      pickedAt: '2020-01-02 12:00',
    }), {
      slug: 'journal-rewards',
      startDate: '2020-01-02',
      endDate: '2020-01-02',
      tasksShipped: 1,
      tasksAttempted: 2,
      wallClockHours: 3,
      haltRatio: 0.5,
      totalReward: 5,
      lessonsGenerated: 0,
    });
  } finally {
    global.Date = RealDate;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
