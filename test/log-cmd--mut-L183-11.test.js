const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { logsDigest } = require('../commands/log');

test('digest does not count the final newline as a journal entry', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'digest-newline-'));
  const previousHome = process.env.HOME;
  const previousCwd = process.cwd();
  const previousLog = console.log;
  const output = [];
  try {
    process.env.HOME = root;
    process.chdir(root);
    const journal = path.join(root, 'atris', 'logs', '2026', '2026-07-12.md');
    fs.mkdirSync(path.dirname(journal), { recursive: true });
    fs.writeFileSync(journal, 'shipped the release\n');
    console.log = (...args) => output.push(args.join(' '));
    logsDigest(['--date', '2026-07-12', '--json'], { cwd: root });
    const payload = JSON.parse(output.join('\n'));
    assert.equal(payload.sections[0].lines.length, 1);
  } finally {
    console.log = previousLog;
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
