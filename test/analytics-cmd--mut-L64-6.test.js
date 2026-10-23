const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { analyticsAtris } = require('../commands/analytics');

test('analytics reports a week whose oldest journal has no inbox heading', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'analytics-no-old-inbox-'));
  const originalCwd = process.cwd();
  const RealDate = global.Date;
  const originalLog = console.log;
  const output = [];
  try {
    const logs = path.join(root, 'atris', 'logs', '2024');
    fs.mkdirSync(logs, { recursive: true });
    fs.writeFileSync(path.join(logs, '2024-01-07.md'),
      '## Inbox\n- **I1:** pending\n## Completed\n');
    fs.writeFileSync(path.join(logs, '2024-01-01.md'),
      '## Completed\n- **C1:** finished\n');
    process.chdir(root);
    global.Date = class extends RealDate {
      constructor(...args) {
        if (args.length) super(...args);
        else super(2024, 0, 7, 12, 0, 0);
      }
    };
    console.log = (...args) => output.push(args.join(' '));
    analyticsAtris();
    assert.deepEqual(output, [
      '',
      '┌─────────────────────────────────────────────────────────────┐',
      `│ Atris Analytics, 2024-01-07${' '.repeat(25)}│`,
      '└─────────────────────────────────────────────────────────────┘',
      '',
      "📊 Today's Performance",
      '   Completions: 0',
      '   Inbox items: 1',
      '',
      '📈 Weekly Trends (Last 7 Days)',
      '   Total completions: 1',
      '   Average velocity: 0.1 completions/day',
      '   Inbox trend: Growing ⬆',
      '',
      '⏰ Productivity Patterns',
      '   Most active hour: No data',
      '   Activity count: 0 timestamps',
      '',
      '📅 Daily Breakdown',
      '   2024-01-07:  0 (today)',
      '   2024-01-06:  0',
      '   2024-01-05:  0',
      '   2024-01-04:  0',
      '   2024-01-03:  0',
      '   2024-01-02:  0',
      '   2024-01-01: █ 1',
      '',
      '─────────────────────────────────────────────────────────────',
      '💡 Insight: This data syncs to backend via "atris log sync"',
      ''
    ]);
  } finally {
    console.log = originalLog;
    global.Date = RealDate;
    process.chdir(originalCwd);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
