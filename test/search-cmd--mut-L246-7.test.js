'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('source matches sort by file before line number', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-search-order-'));
  const previousHome = process.env.HOME;
  const previousCwd = process.cwd();
  const previousLog = console.log;
  const previousExit = process.exit;
  const output = [];
  process.env.HOME = root;
  try {
    const { searchCommand } = require('../commands/search');
    fs.mkdirSync(path.join(root, 'lib'));
    fs.mkdirSync(path.join(root, 'atris'));
    for (const [name, content] of [
      ['a.js', '\n\norderingneedle\n'],
      ['z.js', 'orderingneedle\n'],
    ]) {
      const file = path.join(root, 'lib', name);
      fs.writeFileSync(file, content);
      fs.utimesSync(file, 946684800, 946684800);
    }

    process.chdir(root);
    console.log = (...args) => output.push(args.join(' '));
    process.exit = code => { throw new Error(`unexpected exit: ${code}`); };
    searchCommand(['orderingneedle'], { root });
    const source = output.find(line => line.includes('Source:'));
    assert.ok(source && source.includes('lib/a.js:3'));
  } finally {
    console.log = previousLog;
    process.exit = previousExit;
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
