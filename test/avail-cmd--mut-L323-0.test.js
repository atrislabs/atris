'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('slots consumes --user and its value before rejecting the next unknown flag', async () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'avail-user-'));
  const previousHome = process.env.HOME;
  const previousLog = console.log;
  const previousError = console.error;
  const stdout = [];
  const stderr = [];
  try {
    process.env.HOME = tmpHome;
    const { availCommand } = require('../commands/avail');
    console.log = (...args) => stdout.push(args.join(' '));
    console.error = (...args) => stderr.push(args.join(' '));

    // Both implementations return during parsing, before authentication or HTTP.
    const code = await availCommand(['slots', '--user', 'alice', '--unexpected']);

    assert.deepStrictEqual({ code, stdout, stderr }, {
      code: 1,
      stdout: [],
      stderr: ['atris avail slots does not take "--unexpected". Run: atris avail --help'],
    });
  } finally {
    console.log = previousLog;
    console.error = previousError;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});
