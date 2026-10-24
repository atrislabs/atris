require('./helpers/clean-temp');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { reportCommand } = require('../commands/report');

test('report command uses the value following the days flag', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-days-'));
  const originalHome = process.env.HOME;
  const originalCwd = process.cwd();
  const originalLog = console.log;
  const originalExit = process.exit;
  const output = [];
  try {
    process.env.HOME = home;
    process.chdir(home);
    console.log = (...args) => output.push(args.join(' '));
    process.exit = code => { throw new Error(`unexpected exit: ${code}`); };
    reportCommand(['week', '--days', '3', '--json']);
    assert.strictEqual(JSON.parse(output.join('\n')).days, 3);
  } finally {
    console.log = originalLog;
    process.exit = originalExit;
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  }
});
