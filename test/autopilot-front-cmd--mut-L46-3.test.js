'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('status does not mistake a zero process ID for a running autopilot', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-zero-pid-'));
  const previousHome = process.env.HOME;
  const previousCwd = process.cwd();
  const previousLog = console.log;
  const previousExit = process.exit;
  const output = [];
  try {
    process.env.HOME = root;
    process.chdir(root);
    console.log = (...args) => output.push(args.join(' '));
    process.exit = (code) => { throw new Error(`unexpected exit: ${code}`); };
    const { autopilotFront, writeState } = require('../commands/autopilot-front');
    writeState(root, { pid: 0, legs: 0 });
    await autopilotFront(['status']);
    assert.match(output.join('\n'), /not running/i,
      'zero identifies a process group, not a live autopilot process');
  } finally {
    console.log = previousLog;
    process.exit = previousExit;
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
