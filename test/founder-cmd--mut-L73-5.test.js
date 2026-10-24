'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { founderCommand } = require('../commands/founder');

test('a one-day window is accepted in an empty workspace', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-one-day-'));
  const previousHome = process.env.HOME;
  const previousCwd = process.cwd();
  const previousLog = console.log;
  const previousError = console.error;
  const previousExit = process.exit;
  const output = [];
  process.env.HOME = root;
  process.chdir(root);
  console.log = (...args) => output.push(args.join(' '));
  console.error = (...args) => output.push(args.join(' '));
  process.exit = (code) => { throw new Error(`unexpected exit: ${code}`); };
  try {
    const code = founderCommand(['--days', '1'], {
      cwd: root,
      env: { HOME: root, ATRIS_FOUNDER_NOW: '2026-08-10T12:00:00Z' },
    });
    assert.ok(output.some((line) => line.includes('this folder is empty')));
    assert.strictEqual(code, 0);
  } finally {
    console.log = previousLog;
    console.error = previousError;
    process.exit = previousExit;
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
