'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { securityReviewCommand } = require('../commands/security-review');

test('json output reports an absolute baseline argument relative to the scan root', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'security-review-baseline-path-')));
  const previousCwd = process.cwd();
  const previousLog = console.log;
  const logs = [];
  try {
    fs.writeFileSync(path.join(root, 'clean.js'), 'module.exports = 42;\n');
    process.chdir(root);
    console.log = (...args) => logs.push(args.join(' '));

    const code = securityReviewCommand([
      'clean.js', '--json', '--no-record',
      '--baseline', path.join(root, 'accepted.json'),
    ]);

    assert.equal(code, 0);
    const report = JSON.parse(logs.join('\n'));
    assert.deepEqual(report.baseline, {
      enabled: true,
      path: 'accepted.json',
      updated: false,
      fingerprints: 0,
    });
  } finally {
    console.log = previousLog;
    process.chdir(previousCwd);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
