'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('minimal setup does not report installing skills when none were requested', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-empty-skills-'));
  const previous = {
    cwd: process.cwd(),
    home: process.env.HOME,
    argv: process.argv,
    exit: process.exit,
    log: console.log,
  };
  const output = [];
  try {
    process.env.HOME = home;
    process.chdir(home);
    process.argv = [process.execPath, 'atris', 'init', '--minimal', '--yes'];
    process.exit = (code) => { throw new Error(`unexpected exit: ${code}`); };
    console.log = (...args) => output.push(args.join(' '));
    const { initAtris } = require('../commands/init');
    await initAtris();
    assert.doesNotMatch(output.join('\n'), /skills installed/i);
  } finally {
    console.log = previous.log;
    process.exit = previous.exit;
    process.argv = previous.argv;
    process.chdir(previous.cwd);
    if (previous.home === undefined) delete process.env.HOME;
    else process.env.HOME = previous.home;
  }
});
