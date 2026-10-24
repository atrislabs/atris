const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('a lone long help flag shows usage successfully', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-help-'));
  const cwd = process.cwd();
  const home = process.env.HOME;
  const log = console.log;
  const error = console.error;
  const exit = process.exit;
  const output = [];
  try {
    process.env.HOME = dir;
    process.chdir(dir);
    console.log = console.error = (...args) => output.push(args.join(' '));
    process.exit = code => { throw new Error(`unexpected exit ${code}`); };
    const { reportCommand } = require('../commands/report');
    const result = reportCommand(['--help']);
    assert.match(output.join('\n'), /usage/i);
    assert.equal(result, 0);
  } finally {
    console.log = log;
    console.error = error;
    process.exit = exit;
    process.chdir(cwd);
    if (home === undefined) delete process.env.HOME;
    else process.env.HOME = home;
  }
});
