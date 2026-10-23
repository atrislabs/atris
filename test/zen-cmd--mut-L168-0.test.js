'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { zenCommand } = require('../commands/zen');

test('a missing repository makes the fleet command return failure', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-missing-repo-'));
  const previousHome = process.env.HOME;
  const previousCwd = process.cwd();
  const previousLog = console.log;
  try {
    process.env.HOME = home;
    process.chdir(home);
    console.log = () => {};
    const status = zenCommand(['--all', '--no-fetch', '--json', path.join(home, 'removed-repo')]);
    assert.strictEqual(status, 1);
  } finally {
    console.log = previousLog;
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
