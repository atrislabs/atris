'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run } = require('../commands/goal');
const { readWishes } = require('../lib/wish-store');

test('a goal needing clarification offers answering the saved wish as its next step', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-clarification-'));
  const previousCwd = process.cwd();
  const previousHome = process.env.HOME;
  const previousPath = process.env.PATH;
  const previousLog = console.log;
  const previousError = console.error;
  const previousExit = process.exit;
  const output = [];
  try {
    process.env.HOME = root;
    process.env.PATH = '';
    process.chdir(root);
    fs.mkdirSync(path.join(root, 'atris'));
    console.log = (...args) => output.push(args.join(' '));
    console.error = (...args) => output.push(args.join(' '));
    process.exit = (code) => { throw new Error(`unexpected exit: ${code}`); };

    assert.equal(run(['set', 'make it better'], { cwd: root }), 0);
    const saved = readWishes(root);
    assert.equal(saved.length, 1);
    assert.equal(saved[0].status, 'needs_input');
    const next = output.find((line) => /^next\s/.test(line));
    assert.match(next || '', /atris wish answer\b/);
  } finally {
    console.log = previousLog;
    console.error = previousError;
    process.exit = previousExit;
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
});
