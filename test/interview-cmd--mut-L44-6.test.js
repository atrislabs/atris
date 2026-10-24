'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const { EventEmitter } = require('node:events');

test('an empty workspace supplies no missing context files to the interview', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'interview-empty-'));
  const previousHome = process.env.HOME;
  const previousCwd = process.cwd();
  const previousSpawn = childProcess.spawn;
  const previousLog = console.log;
  let prompt = '';
  try {
    process.env.HOME = root;
    process.chdir(root);
    fs.mkdirSync(path.join(root, 'atris'));
    console.log = () => {};
    childProcess.spawn = (_command, args) => {
      prompt = args[0];
      const child = new EventEmitter();
      process.nextTick(() => child.emit('exit', 0));
      return child;
    };
    const { interviewCommand } = require('../commands/interview');
    await interviewCommand(['me', '--yes'], root);
    assert.equal(prompt.includes(path.join(root, 'atris', 'now.md')), false);
  } finally {
    childProcess.spawn = previousSpawn;
    console.log = previousLog;
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
