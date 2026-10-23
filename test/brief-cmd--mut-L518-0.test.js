'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('review routes to the review JSON report', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-review-route-'));
  const originalHome = process.env.HOME;
  const originalCwd = process.cwd();
  const originalLog = console.log;
  const originalExit = process.exit;
  const output = [];
  try {
    process.env.HOME = dir;
    process.chdir(dir);
    console.log = (...args) => output.push(args.join(' '));
    process.exit = (code) => { throw new Error(`unexpected exit: ${code}`); };
    const { briefCommand } = require('../commands/brief');
    await briefCommand(['review', '--json'], dir, {
      stdin: { isTTY: false },
      stdout: { isTTY: false },
    });
    assert.match(output.join('\n'), /"schema"\s*:\s*"atris\.brief\.review\.v1"/);
  } finally {
    console.log = originalLog;
    process.exit = originalExit;
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  }
});
