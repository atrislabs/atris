require('./helpers/clean-temp');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('limited log retains the date of the newest entry from the first day', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-log-date-'));
  const previousCwd = process.cwd();
  const previousHome = process.env.HOME;
  const previousLog = console.log;
  const previousExit = process.exit;
  const lines = [];
  try {
    process.env.HOME = root;
    process.chdir(root);
    const wikiDir = path.join(root, 'atris', 'wiki');
    fs.mkdirSync(wikiDir, { recursive: true });
    fs.writeFileSync(path.join(wikiDir, 'log.md'), [
      '# Wiki log',
      '',
      '## 2024-01-15',
      '- 09:00 ingested irrigation notes',
      '- 10:00 compiled irrigation guide',
      '',
    ].join('\n'));
    console.log = (...args) => lines.push(args.join(' '));
    process.exit = (code) => { throw new Error(`unexpected exit: ${code}`); };
    const { wikiCommand } = require('../commands/wiki');
    await wikiCommand('log', '1');
    assert.ok(lines.some((line) => /^##\s+2024-01-15\b/.test(line)),
      'the selected entry must retain its day heading');
  } finally {
    console.log = previousLog;
    process.exit = previousExit;
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
