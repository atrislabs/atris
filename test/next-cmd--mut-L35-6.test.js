'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { nextCommand } = require('../commands/next');

test('skipping an empty card list does not offer a next action', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-empty-skip-'));
  const cwd = process.cwd();
  const home = process.env.HOME;
  const exit = process.exit;
  const log = console.log;
  const lines = [];
  try {
    process.env.HOME = root;
    process.chdir(root);
    process.exit = (code) => { throw new Error(`unexpected exit: ${code}`); };
    console.log = (line) => lines.push(String(line));
    nextCommand(['skip'], root);
    assert.equal(lines.join('\n').split('\n').some((line) => /^next\s*:/.test(line)), false);
  } finally {
    console.log = log;
    process.exit = exit;
    process.chdir(cwd);
    if (home === undefined) delete process.env.HOME;
    else process.env.HOME = home;
  }
});
