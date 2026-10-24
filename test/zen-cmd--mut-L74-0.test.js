'use strict';
require('./helpers/clean-temp');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { zenCommand } = require('../commands/zen');

test('checking without fetching does not claim origin was unreachable', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-note-'));
  const home = process.env.HOME;
  const cwd = process.cwd();
  const log = console.log;
  const exit = process.exit;
  const lines = [];
  try {
    process.env.HOME = root;
    process.chdir(root);
    execFileSync('git', ['init', '-b', 'main'], { cwd: root, stdio: 'pipe' });
    console.log = (...args) => lines.push(args.join(' '));
    process.exit = code => { throw new Error(`unexpected exit ${code}`); };
    zenCommand(['--check', '--no-fetch'], root);
    assert.equal(lines.some(line => /could not reach origin/i.test(line)), false);
  } finally {
    console.log = log;
    process.exit = exit;
    process.chdir(cwd);
    if (home === undefined) delete process.env.HOME;
    else process.env.HOME = home;
  }
});
