require('./helpers/clean-temp');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { initAtris } = require('../commands/init');

test('initializes an ordinary project directory without force', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinary-init-'));
  const project = path.join(home, 'project');
  fs.mkdirSync(project);
  const previous = { cwd: process.cwd(), home: process.env.HOME, argv: process.argv,
    exit: process.exit, log: console.log, error: console.error, warn: console.warn };
  const stopped = new Error('initialization stopped');
  try {
    process.env.HOME = home;
    process.chdir(project);
    process.argv = [process.execPath, 'atris', 'init', '--yes', '--minimal', '--no-commit'];
    console.log = console.error = console.warn = () => {};
    process.exit = () => { throw stopped; };
    try {
      await initAtris();
    } catch (error) {
      if (error !== stopped) throw error;
    }
    assert.ok(fs.existsSync(path.join(project, 'atris')), 'creates the workspace in an ordinary project');
  } finally {
    process.chdir(previous.cwd);
    if (previous.home === undefined) delete process.env.HOME;
    else process.env.HOME = previous.home;
    process.argv = previous.argv;
    process.exit = previous.exit;
    console.log = previous.log;
    console.error = previous.error;
    console.warn = previous.warn;
  }
});
