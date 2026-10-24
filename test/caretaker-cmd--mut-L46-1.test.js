'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { caretakerCommand } = require('../commands/caretaker');

test('an authenticated scan with no open pull requests succeeds', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caretaker-empty-'));
  const cwd = process.cwd();
  const home = process.env.HOME;
  const searchPath = process.env.PATH;
  const output = [];
  t.mock.method(console, 'log', (...args) => output.push(args.join(' ')));
  t.mock.method(console, 'error', (...args) => output.push(args.join(' ')));
  t.mock.method(process, 'exit', (code) => { throw new Error(`unexpected exit ${code}`); });
  fs.mkdirSync(path.join(dir, 'atris'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'gh'), `#!${process.execPath}
const args = process.argv.slice(2);
if (args.join(' ') === '--version') {
  console.log('gh version 2.74.0');
} else if (args.join(' ') === 'auth status') {
  console.log('github.com: logged in as test-user');
} else if (args[0] === 'pr' && args[1] === 'list') {
  console.log('[]');
} else {
  console.error('unsupported gh command');
  process.exitCode = 1;
}
`, { mode: 0o755 });
  try {
    process.env.HOME = dir;
    process.env.PATH = bin;
    process.chdir(dir);
    assert.strictEqual(caretakerCommand(['scan']), 0, output.join('\n'));
    const receipt = JSON.parse(fs.readFileSync(path.join(dir, '.atris', 'state', 'caretaker.scan.latest.json'), 'utf8'));
    assert.strictEqual(receipt.prs.length, 0);
  } finally {
    process.chdir(cwd);
    if (home === undefined) delete process.env.HOME;
    else process.env.HOME = home;
    if (searchPath === undefined) delete process.env.PATH;
    else process.env.PATH = searchPath;
  }
});
