const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('explicit account scope requires login in a fresh home', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-account-errors-'));
  const saved = {
    home: process.env.HOME,
    cwd: process.cwd(),
    argv: process.argv,
    log: console.log,
    error: console.error,
    exit: process.exit,
  };
  const errors = [];
  const exitSignal = new Error('command exited');
  try {
    process.env.HOME = dir;
    process.chdir(dir);
    process.argv = [process.execPath, 'atris', 'errors', '--account'];
    console.log = () => {};
    console.error = (...args) => errors.push(args.join(' '));
    process.exit = () => { throw exitSignal; };
    const { errorsCommand } = require('../commands/errors');
    try {
      await errorsCommand();
    } catch (error) {
      if (error !== exitSignal) throw error;
    }
    assert.ok(errors.some(line => /not logged in/i.test(line)));
  } finally {
    process.chdir(saved.cwd);
    process.argv = saved.argv;
    console.log = saved.log;
    console.error = saved.error;
    process.exit = saved.exit;
    if (saved.home === undefined) delete process.env.HOME;
    else process.env.HOME = saved.home;
  }
});
