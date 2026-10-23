const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('full setup still reports the team and creation hint when members already exist', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-team-summary-'));
  const previous = {
    cwd: process.cwd(),
    home: process.env.HOME,
    argv: process.argv,
    log: console.log,
    exit: process.exit,
  };
  const lines = [];
  try {
    process.env.HOME = home;
    process.chdir(home);
    process.argv = ['node', 'atris', 'init', '--full', '--yes', '--no-commit'];
    console.log = (...args) => lines.push(args.join(' '));
    process.exit = (code) => { throw new Error(`unexpected exit: ${code}`); };
    const { initAtris } = require('../commands/init');
    initAtris();
    lines.length = 0;
    initAtris();

    assert.ok(lines.some(line => /team members ready\s*\(0\)/i.test(line)),
      'repeated full setup should report that no additional team members were needed');
    assert.ok(lines.some(line => /more members.*atris member create/i.test(line)),
      'full setup should still tell users how to add team members');
  } finally {
    process.chdir(previous.cwd);
    process.argv = previous.argv;
    console.log = previous.log;
    process.exit = previous.exit;
    if (previous.home === undefined) delete process.env.HOME;
    else process.env.HOME = previous.home;
  }
});
