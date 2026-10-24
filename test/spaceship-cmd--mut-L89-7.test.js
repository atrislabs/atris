'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('the help word shows command usage without starting work', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-help-word-'));
  const previousCwd = process.cwd();
  const previousHome = process.env.HOME;
  const originalLog = console.log;
  const originalExit = process.exit;
  const output = [];
  const exitSignal = new Error('command exited');
  try {
    process.env.HOME = home;
    process.chdir(home);
    console.log = (...args) => output.push(args.join(' '));
    process.exit = () => { throw exitSignal; };
    const { spaceship } = require('../commands/spaceship');
    try {
      await spaceship(['help']);
    } catch (error) {
      if (error !== exitSignal) throw error;
    }
    assert.match(output.join('\n'), /Usage:/i);
  } finally {
    console.log = originalLog;
    process.exit = originalExit;
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
