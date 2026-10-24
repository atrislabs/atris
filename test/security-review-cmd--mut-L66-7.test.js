'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { securityReviewCommand } = require('../commands/security-review');

function capture(fn) {
  const logs = [];
  const errs = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...args) => { logs.push(args.map(String).join(' ')); };
  console.error = (...args) => { errs.push(args.map(String).join(' ')); };
  try {
    const code = fn();
    return { code, stdout: logs.join('\n'), stderr: errs.join('\n') };
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
}

function withTempHome(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-sec-review-md-'));
  const prevHome = process.env.HOME;
  const prevCwd = process.cwd();
  process.env.HOME = dir;
  process.chdir(dir);
  try {
    return fn(dir);
  } finally {
    process.chdir(prevCwd);
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('securityReviewCommand renders markdown report with --md and --markdown', () => {
  withTempHome((dir) => {
    fs.writeFileSync(path.join(dir, 'clean.js'), 'module.exports = 1;\n');

    const resMd = capture(() => securityReviewCommand(['.', '--md', '--no-record']));
    assert.strictEqual(resMd.code, 0, resMd.stderr);
    assert.match(resMd.stdout, /^# Atris Security Review/m);
    assert.match(resMd.stdout, /^## Active Counts/m);

    const resMarkdown = capture(() => securityReviewCommand(['.', '--markdown', '--no-record']));
    assert.strictEqual(resMarkdown.code, 0, resMarkdown.stderr);
    assert.match(resMarkdown.stdout, /^# Atris Security Review/m);
    assert.match(resMarkdown.stdout, /^## Active Counts/m);
  });
});
