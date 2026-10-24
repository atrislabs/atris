'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { caretakerCommand } = require('../commands/caretaker');

test('scan ignores a missing check entry beside a passing check', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'check-rollup-'));
  const previousHome = process.env.HOME;
  const previousCwd = process.cwd();
  t.after(() => {
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  });
  process.env.HOME = root;
  process.chdir(root);
  const output = [];
  t.mock.method(console, 'log', (...args) => output.push(args.join(' ')));
  t.mock.method(console, 'error', () => {});
  t.mock.method(process, 'exit', (code) => { throw new Error(`exit ${code}`); });

  const detail = {
    number: 12,
    title: 'repair checks',
    headRefOid: 'abc123',
    statusCheckRollup: [null, { name: 'unit', status: 'COMPLETED', conclusion: 'SUCCESS' }],
    reviews: [],
    latestReviews: [],
    commits: [],
  };
  fs.writeFileSync(path.join(root, 'gh'), `#!${process.execPath}\n` +
    `const args = process.argv.slice(2);\n` +
    `if (args[0] === 'pr') console.log(JSON.stringify(args[1] === 'list' ? [{ number: 12, title: 'repair checks', headRefOid: 'abc123' }] : ${JSON.stringify(detail)}));\n`,
  { mode: 0o755 });

  caretakerCommand(['scan'], {
    cwd: root,
    env: { HOME: root, PATH: root },
    now: new Date('2025-01-15T12:00:00Z'),
  });
  assert.ok(output.some((line) => line.includes('green-mergeable')));
});
