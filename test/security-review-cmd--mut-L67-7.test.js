'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { securityReviewCommand } = require('../commands/security-review');

test('both landing flags print the shipping decision for a clean scan', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-landing-flag-'));
  const previousHome = process.env.HOME;
  const previousCwd = process.cwd();
  const previousLog = console.log;
  const previousError = console.error;
  try {
    process.env.HOME = dir;
    process.chdir(dir);
    fs.writeFileSync(path.join(dir, 'clean.js'), 'module.exports = 42;\n');
    for (const flag of ['--land', '--landing']) {
      const output = [];
      const errors = [];
      console.log = (...args) => output.push(args.map(String).join(' '));
      console.error = (...args) => errors.push(args.map(String).join(' '));
      const code = securityReviewCommand(['clean.js', flag, '--no-record', '--no-baseline']);
      assert.match(output.join('\n'), /\bCLEARED\s+TO\s+SHIP\b/, `${flag} must show the landing decision; ${errors.join('\n')}`);
      assert.equal(code, 0, errors.join('\n'));
    }
  } finally {
    console.log = previousLog;
    console.error = previousError;
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
