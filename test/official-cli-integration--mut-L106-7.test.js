const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createOfficialCliCommand } = require('../lib/official-cli-integration');

test('auth returns success after the configured authentication check passes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-auth-doctor-'));
  const previousHome = process.env.HOME;
  const previousCwd = process.cwd();
  const originalLog = console.log;
  const originalError = console.error;
  const originalExit = process.exit;
  const output = [];
  try {
    process.env.HOME = dir;
    process.chdir(dir);
    const binary = path.join(dir, 'sample-cli');
    fs.writeFileSync(binary, `#!${process.execPath}\nconsole.log(process.argv.includes('--version') ? 'sample 1.0.0' : 'authenticated');\n`, { mode: 0o755 });
    console.log = (...args) => output.push(args.join(' '));
    console.error = (...args) => output.push(args.join(' '));
    process.exit = (code) => { throw new Error(`unexpected exit: ${code}`); };
    const command = createOfficialCliCommand({
      name: 'sample', binary, versionArgs: ['--version'],
      authArgs: ['account', 'check'], commands: [],
    });
    const result = command(['auth']);
    assert.match(output.join('\n'), /auth:\s*ok/);
    assert.equal(result, 0);
  } finally {
    console.log = originalLog;
    console.error = originalError;
    process.exit = originalExit;
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
