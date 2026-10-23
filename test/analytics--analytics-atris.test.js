const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { analyticsAtris } = require('../commands/analytics');

// The command has no date argument, so freeze its local calendar at noon.
// Each test is synchronous and restores all process-wide changes in finally.
function report(journals) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-analytics-test-'));
  const originalCwd = process.cwd();
  const RealDate = global.Date;
  const originalLog = console.log;
  const lines = [];
  try {
    const logs = path.join(root, 'atris', 'logs');
    fs.mkdirSync(logs, { recursive: true });
    for (const [date, content] of Object.entries(journals)) {
      const dir = path.join(logs, date.slice(0, 4));
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${date}.md`), content);
    }
    process.chdir(root);
    global.Date = class extends RealDate {
      constructor(...args) {
        if (args.length) super(...args);
        else super(2024, 0, 3, 12, 0, 0);
      }
      static now() { return new RealDate(2024, 0, 3, 12, 0, 0).getTime(); }
    };
    console.log = (...args) => lines.push(args.join(' '));
    assert.strictEqual(analyticsAtris(), undefined);
    return lines;
  } finally {
    console.log = originalLog;
    global.Date = RealDate;
    process.chdir(originalCwd);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('analyticsAtris reports journal totals, inbox trend, and activity across a year boundary', () => {
  const lines = report({
    '2024-01-03': '## Inbox\r\n- **I1:** pending\r\n## Completed\r\n- **C1:** done\r\n- **C2:** done\r\n### Work -- 09:15\r\n### More - 09:45\r\n',
    '2024-01-02': '- **C3:** done\n**14:30:00**\n',
    '2023-12-28': '## Inbox\n- **I1:** old\n- **I2:** old\n## Completed\n- **C4:** done\n',
    '2023-12-27': '- **C99:** outside the window\n**05:00**\n'
  });
  for (const line of [
    '   Completions: 2', '   Inbox items: 1',
    '   Total completions: 4', '   Average velocity: 0.6 completions/day',
    '   Inbox trend: Shrinking ⬇', '   Most active hour: 9:00 - 10:00',
    '   Activity count: 2 timestamps'
  ]) assert.ok(lines.includes(line), line);
  assert.deepStrictEqual(lines.filter(line => /^   \d{4}-/.test(line)), [
    '   2024-01-03: ██ 2 (today)', '   2024-01-02: █ 1',
    '   2024-01-01:  0', '   2023-12-31:  0',
    '   2023-12-30:  0', '   2023-12-29:  0', '   2023-12-28: █ 1'
  ]);
});

test('analyticsAtris caps bars, ignores invalid hours and prose, and wraps midnight', () => {
  const lines = report({
    '2024-01-03': [
      '## Inbox', '- **I1:** pending', '---', '- **I2:** outside inbox',
      ...Array.from({ length: 45 }, (_, i) => `- **C${i + 1}:** done`),
      '### Late — 23:15', '**23:45:00**',
      '### Invalid -- 24:00', '**99:00**', 'prose 10:00 - 12:30'
    ].join('\n')
  });
  assert.ok(lines.includes(`   2024-01-03: ${'█'.repeat(40)} 45 (today)`));
  assert.ok(lines.includes('   Total completions: 45'));
  assert.ok(lines.includes('   Inbox items: 1'));
  assert.ok(lines.includes('   Inbox trend: Growing ⬆'));
  assert.ok(lines.includes('   Most active hour: 23:00 - 0:00'));
  assert.ok(lines.includes('   Activity count: 2 timestamps'));
});

test('analyticsAtris handles an empty logs folder without activity', () => {
  const lines = report({});
  for (const line of [
    '   Completions: 0', '   Inbox items: 0',
    '   Total completions: 0', '   Average velocity: 0.0 completions/day',
    '   Inbox trend: Stable →', '   Most active hour: No data',
    '   Activity count: 0 timestamps'
  ]) assert.ok(lines.includes(line), line);
  const days = lines.filter(line => /^   \d{4}-/.test(line));
  assert.strictEqual(days.length, 7);
  assert.ok(days.every(line => /:  0(?: \(today\))?$/.test(line)));
});
