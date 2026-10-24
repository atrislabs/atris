require('./helpers/clean-temp');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createOfficialCliCommand } = require('../lib/official-cli-integration');

test('doctor identifies a missing configured binary as not installed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-missing-cli-'));
  const home = process.env.HOME;
  const cwd = process.cwd();
  const log = console.log;
  const error = console.error;
  const exit = process.exit;
  const output = [];
  try {
    process.env.HOME = dir;
    process.chdir(dir);
    console.log = console.error = (...args) => output.push(args.join(' '));
    process.exit = (code) => { throw new Error(`unexpected exit ${code}`); };
    const command = createOfficialCliCommand({
      name: 'sample',
      binary: path.join(dir, 'not-installed'),
      installHint: 'install sample locally',
      commands: [],
    });
    command(['doctor']);
    assert.match(output.join('\n'), /cli not found/i);
  } finally {
    process.chdir(cwd);
    if (home === undefined) delete process.env.HOME;
    else process.env.HOME = home;
    console.log = log;
    console.error = error;
    process.exit = exit;
  }
});
