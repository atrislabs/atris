'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { skillCommand } = require('../commands/skill');

test('create without a name exits with a usage error', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-help-'));
  const cwd = process.cwd();
  const home = process.env.HOME;
  const log = console.log;
  const error = console.error;
  const exit = process.exit;
  let exitCode;
  const signal = new Error('exit intercepted');
  try {
    process.chdir(root);
    process.env.HOME = root;
    console.log = console.error = () => {};
    process.exit = (code) => { exitCode = code; throw signal; };
    try {
      await skillCommand('create');
    } catch (err) {
      if (err !== signal) throw err;
    }
    assert.equal(exitCode, 1);
  } finally {
    process.chdir(cwd);
    if (home === undefined) delete process.env.HOME;
    else process.env.HOME = home;
    console.log = log;
    console.error = error;
    process.exit = exit;
  }
});
