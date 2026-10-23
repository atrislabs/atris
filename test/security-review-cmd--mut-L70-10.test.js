'use strict';

const test = require('node:test');
const assert = require('node:assert');
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

test('baseline flag first with a path is accepted and echoed in the report', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-sec-review-mut-'));
  const prevHome = process.env.HOME;
  const prevCwd = process.cwd();
  process.env.HOME = dir;
  process.chdir(dir);
  try {
    const res = capture(() => securityReviewCommand(['--baseline', 'base.json', '.', '--json', '--no-record']));
    assert.strictEqual(res.code, 0, res.stderr);
    const report = JSON.parse(res.stdout);
    assert.strictEqual(report.baseline.path, 'base.json');
  } finally {
    process.chdir(prevCwd);
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
