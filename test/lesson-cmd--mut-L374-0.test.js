'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('mine dispatch reports the mining action in JSON mode', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-mine-dispatch-'));
  const previousCwd = process.cwd();
  const previousHome = process.env.HOME;
  const previousLog = console.log;
  const previousError = console.error;
  const previousExit = process.exit;
  const output = [];
  const exitSignal = new Error('command exited');
  let exitCode;

  try {
    process.env.HOME = root;
    process.chdir(root);
    fs.mkdirSync(path.join(root, 'atris'));
    console.log = (...args) => output.push(args.join(' '));
    console.error = () => {};
    process.exit = (code) => {
      exitCode = code;
      throw exitSignal;
    };

    const lesson = require('../commands/lesson');
    try {
      lesson('mine', '--json', '--dry-run');
    } catch (error) {
      if (error !== exitSignal) throw error;
    }

    const report = output.find((line) => line.trim().startsWith('{'));
    assert.ok(report, 'mine must emit a JSON mining report rather than usage');
    assert.equal(JSON.parse(report).action, 'lesson_mine');
    assert.equal(exitCode, undefined, 'successful mining must return normally');
  } finally {
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    console.log = previousLog;
    console.error = previousError;
    process.exit = previousExit;
  }
});
