'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { securityReviewCommand } = require('../commands/security-review');

test('landing with exactly ten open findings lists them without a remainder', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-security-ten-'));
  const previousCwd = process.cwd();
  const previousLog = console.log;
  const previousError = console.error;
  const logs = [];
  const errors = [];
  try {
    fs.writeFileSync(path.join(dir, 'leak.js'),
      Array.from({ length: 10 }, () => '"AKIA4F7D9Q2L8W6R3P5S";').join('\n') + '\n');
    process.chdir(dir);
    console.log = (...args) => logs.push(args.join(' '));
    console.error = (...args) => errors.push(args.join(' '));

    const code = securityReviewCommand(['leak.js', '--land', '--no-baseline', '--no-record']);
    assert.equal(code, 1);
    assert.deepEqual(errors, []);
    assert.equal(logs.length, 1);
    // Compare the complete date-independent suffix, including the space where
    // an incorrect "and 0 more" line would appear.
    const output = logs[0];
    const start = output.indexOf('  needs you:\n');
    assert.notEqual(start, -1);
    assert.equal(output.slice(start), [
      '  needs you:',
      ...Array.from({ length: 10 }, (_, i) =>
        `    CRITICAL leak.js:${i + 1}, real-looking AWS access key id`),
      '',
      '  posture: 1 run recorded · scanned 1 files',
      '',
    ].join('\n'));
  } finally {
    console.log = previousLog;
    console.error = previousError;
    process.chdir(previousCwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
