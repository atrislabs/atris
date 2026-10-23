'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const { runDrill } = require('../commands/drill');

test('stage output capture preserves command diagnostic file writes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drill-write-'));
  const previousCwd = process.cwd();
  const previousHome = process.env.HOME;
  const previousTmp = process.env.TMPDIR;
  const originalExec = childProcess.execFileSync;
  const diagnostic = path.join(root, 'command.log');
  process.env.HOME = root;
  process.env.TMPDIR = root;
  process.chdir(root);
  // A failing command adapter records its diagnostic before reporting failure.
  childProcess.execFileSync = () => {
    const fd = fs.openSync(diagnostic, 'w');
    try {
      fs.writeSync(fd, 'command unavailable\n');
    } finally {
      fs.closeSync(fd);
    }
    throw new Error('command unavailable');
  };
  try {
    await runDrill({ reporter: () => {} });
    assert.equal(fs.readFileSync(diagnostic, 'utf8').includes('command unavailable'), true);
  } finally {
    childProcess.execFileSync = originalExec;
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmp;
  }
});
