'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');

test('while commands use a separate process group on Unix for group cancellation', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-while-group-'));
  const previousHome = process.env.HOME;
  const previousCwd = process.cwd();
  const tty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  const spawn = childProcess.spawn;
  let detached;

  t.mock.method(childProcess, 'spawn', (command, options) => {
    detached = options.detached;
    return spawn(command, options);
  });
  t.mock.method(console, 'log', () => {});

  try {
    process.env.HOME = home;
    process.chdir(home);
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false });
    const { run } = require('../commands/study');
    await run(['--while', `"${process.execPath}" -e ""`]);
    assert.strictEqual(detached, process.platform !== 'win32');
  } finally {
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (tty) Object.defineProperty(process.stdin, 'isTTY', tty);
    else delete process.stdin.isTTY;
  }
});
