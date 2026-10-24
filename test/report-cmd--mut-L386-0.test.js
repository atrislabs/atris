const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { reportCommand } = require('../commands/report');

test('rejects an unsupported report period with a separate days value', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-report-period-'));
  const cwd = process.cwd();
  const home = process.env.HOME;
  const log = console.log;
  const exit = process.exit;
  const output = [];
  try {
    process.env.HOME = dir;
    process.chdir(dir);
    console.log = (...args) => output.push(args.join(' '));
    process.exit = code => { throw new Error(`unexpected exit: ${code}`); };
    const code = reportCommand(['month', '--days', '3']);
    assert.strictEqual(code, 1);
    assert.match(output.join('\n'), /usage:/i);
  } finally {
    process.chdir(cwd);
    if (home === undefined) delete process.env.HOME;
    else process.env.HOME = home;
    console.log = log;
    process.exit = exit;
  }
});
