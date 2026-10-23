'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { securityReviewCommand } = require('../commands/security-review');

test('equal severity findings sort by filename before line number', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'finding-order-'));
  const previousHome = process.env.HOME;
  const previousCwd = process.cwd();
  const previousLog = console.log;
  const output = [];
  try {
    process.env.HOME = dir;
    process.chdir(dir);
    fs.writeFileSync(path.join(dir, 'a.js'), '\n\nconst key = "AKIA4F7D9Q2L8W6R3P5S";\n');
    fs.writeFileSync(path.join(dir, 'b.js'), 'const key = "AKIA4F7D9Q2L8W6R3P5S";\n');
    console.log = (...args) => output.push(args.join(' '));
    securityReviewCommand(['.', '--json', '--no-record']);
    const report = JSON.parse(output.join('\n'));
    assert.equal(report.findings[0].file, 'a.js');
  } finally {
    console.log = previousLog;
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
