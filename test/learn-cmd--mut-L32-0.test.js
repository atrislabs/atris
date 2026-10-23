'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const learn = require('../commands/learn');

test('recent view explains an empty learning collection', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-empty-learnings-'));
  const previousCwd = process.cwd();
  const previousHome = process.env.HOME;
  const previousLog = console.log;
  const previousExit = process.exit;
  const lines = [];
  try {
    process.env.HOME = home;
    process.chdir(home);
    fs.mkdirSync(path.join(home, 'atris'));
    console.log = (...args) => lines.push(args.join(' '));
    process.exit = (code) => { throw new Error(`unexpected exit ${code}`); };
    learn();
    assert.ok(lines.some(line => /no learnings yet/i.test(line)));
  } finally {
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    console.log = previousLog;
    process.exit = previousExit;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
