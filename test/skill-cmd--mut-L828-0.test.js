'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { skillCommand } = require('../commands/skill');

test('link installs a discovered local skill into the home skills folder', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-link-present-'));
  const previousCwd = process.cwd();
  const previousHome = process.env.HOME;
  const previousLog = console.log;
  const previousError = console.error;
  const previousExit = process.exit;
  const exitSignal = new Error('intercepted exit');
  try {
    process.env.HOME = root;
    process.chdir(root);
    console.log = () => {};
    console.error = () => {};
    process.exit = () => { throw exitSignal; };
    const source = path.join(process.cwd(), 'atris', 'skills', 'sample');
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, 'SKILL.md'), '---\nname: sample\ndescription: Use when checking a sample.\n---\n1. Check the sample.\n');

    try {
      skillCommand('link', '--all');
    } catch (error) {
      if (error !== exitSignal) throw error;
    }

    const destination = path.join(root, '.claude', 'skills', 'sample');
    assert.equal(fs.existsSync(destination), true);
    assert.equal(fs.realpathSync(destination), fs.realpathSync(source));
  } finally {
    process.exit = previousExit;
    console.log = previousLog;
    console.error = previousError;
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
