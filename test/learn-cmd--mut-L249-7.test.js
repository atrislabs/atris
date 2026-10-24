'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');

test('negative confidence stops interactive entry before asking for source', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'learn-confidence-'));
  const previousHome = process.env.HOME;
  const previousCwd = process.cwd();
  const previousInterface = readline.createInterface;
  const previousLog = console.log;
  const previousError = console.error;
  const previousExit = process.exit;
  const prompts = [];
  process.env.HOME = home;
  process.chdir(home);
  fs.mkdirSync(path.join(home, 'atris'));
  readline.createInterface = () => ({
    question(prompt, answer) {
      prompts.push(prompt);
      answer(/confidence/i.test(prompt) ? '-1'
        : /type:/i.test(prompt) ? 'pattern'
        : /key/i.test(prompt) ? 'map-first'
        : /insight/i.test(prompt) ? 'check the map before searching'
        : /source/i.test(prompt) ? 'observed' : '');
    },
    close() {},
  });
  console.log = console.error = () => {};
  process.exit = (code) => { throw new Error(`unexpected exit: ${code}`); };
  try {
    const learn = require('../commands/learn');
    learn('add');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(prompts.some((prompt) => /source/i.test(prompt)), false);
  } finally {
    readline.createInterface = previousInterface;
    console.log = previousLog;
    console.error = previousError;
    process.exit = previousExit;
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
