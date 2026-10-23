const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { analyticsAtris } = require('../commands/analytics');

test('a journal without an inbox still prints its completion and zero inbox totals', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'analytics-no-inbox-'));
  const originalCwd = process.cwd();
  const OriginalDate = global.Date;
  const originalLog = console.log;
  const output = [];
  try {
    const logs = path.join(root, 'atris', 'logs', '2024');
    fs.mkdirSync(logs, { recursive: true });
    // A present journal with no Inbox heading makes the inbox match null.
    fs.writeFileSync(path.join(logs, '2024-06-12.md'), '## Completed\n- **C1:** finished\n');
    global.Date = class extends OriginalDate {
      constructor(...args) {
        if (args.length) super(...args);
        else super(2024, 5, 12, 12, 0, 0);
      }
      static now() { return new OriginalDate(2024, 5, 12, 12, 0, 0).getTime(); }
    };
    process.chdir(root);
    console.log = (...args) => output.push(args.join(' '));

    analyticsAtris();

    assert.deepEqual(output.filter(line =>
      line.startsWith('   Completions:') || line.startsWith('   Inbox items:') ||
      line.startsWith('   Total completions:') || line.startsWith('   Inbox trend:')
    ), [
      '   Completions: 1',
      '   Inbox items: 0',
      '   Total completions: 1',
      '   Inbox trend: Stable →'
    ]);
  } finally {
    console.log = originalLog;
    global.Date = OriginalDate;
    process.chdir(originalCwd);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
