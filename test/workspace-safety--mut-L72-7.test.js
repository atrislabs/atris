'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { assertSafeWorkspaceRoot } = require('../lib/workspace-safety');

test('refusing an unsafe push names the requested operation', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-refuse-push-'));
  const previousHome = process.env.HOME;
  const previousCwd = process.cwd();
  const previousExit = process.exit;
  const previousError = console.error;
  const previousLog = console.log;
  const output = [];
  const stopped = new Error('stopped');
  try {
    process.env.HOME = home;
    process.chdir(home);
    process.exit = () => { throw stopped; };
    console.error = (...args) => output.push(args.join(' '));
    console.log = (...args) => output.push(args.join(' '));
    try {
      assertSafeWorkspaceRoot(home, { op: 'push from' });
    } catch (error) {
      if (error !== stopped) throw error;
    }
    assert.match(output.join('\n'), /\bpush from\b/);
  } finally {
    process.exit = previousExit;
    console.error = previousError;
    console.log = previousLog;
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
