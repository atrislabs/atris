const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { analyticsAtris } = require('../commands/analytics');

test('analytics counts midnight timestamps as activity in hour zero', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'analytics-midnight-'));
  const originalCwd = process.cwd();
  const RealDate = global.Date;
  const originalLog = console.log;
  const lines = [];

  try {
    const logs = path.join(root, 'atris', 'logs', '2024');
    fs.mkdirSync(logs, { recursive: true });
    fs.writeFileSync(path.join(logs, '2024-01-03.md'),
      '### Midnight work -- 00:15\n**00:45:00**\n### Morning work -- 09:30\n');
    global.Date = class extends RealDate {
      constructor(...args) {
        if (args.length) super(...args);
        else super(2024, 0, 3, 12, 0, 0);
      }
    };
    process.chdir(root);
    console.log = (...args) => lines.push(args.join(' '));

    analyticsAtris();

    assert.deepEqual(lines.filter(line =>
      line.startsWith('   Most active hour:') ||
      line.startsWith('   Activity count:')), [
      '   Most active hour: 0:00 - 1:00',
      '   Activity count: 2 timestamps'
    ]);
  } finally {
    console.log = originalLog;
    global.Date = RealDate;
    process.chdir(originalCwd);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
