const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { initAtris } = require('../commands/init');

test('initializing preserves an existing member without a legacy copy', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-preserve-member-'));
  const originalCwd = process.cwd();
  const originalArgv = process.argv;
  const originalHome = process.env.HOME;
  const originalLog = console.log;
  const originalError = console.error;
  const originalExit = process.exit;
  const output = [];
  const member = path.join(root, 'atris', 'team', 'navigator', 'MEMBER.md');
  try {
    process.env.HOME = root;
    process.chdir(root);
    process.argv = [process.execPath, 'atris', 'init', '--full', '--force', '--yes', '--no-commit'];
    console.log = console.error = (...args) => output.push(args.join(' '));
    process.exit = (code) => { throw new Error(`unexpected exit ${code}`); };
    fs.mkdirSync(path.dirname(member), { recursive: true });
    fs.writeFileSync(member, '---\nname: navigator\nrole: Navigation\ndescription: Maintain project routes.\n---\n\n# Navigator\n\nAlways consult the custom route handbook.\n');
    await initAtris();
    assert.ok(fs.readFileSync(member, 'utf8').includes('custom route handbook'));
  } finally {
    process.exit = originalExit;
    console.log = originalLog;
    console.error = originalError;
    process.argv = originalArgv;
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  }
});
