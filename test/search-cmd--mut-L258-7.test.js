'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('search displays a matching map entry with default layers', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-search-layers-'));
  const cwd = process.cwd();
  const home = process.env.HOME;
  const log = console.log;
  const exit = process.exit;
  const output = [];
  try {
    process.env.HOME = root;
    process.chdir(root);
    fs.mkdirSync(path.join(root, 'atris'));
    fs.writeFileSync(path.join(root, 'atris', 'MAP.md'), '# map\nzebraflow lives here\n');
    const { searchCommand } = require('../commands/search');
    console.log = (...args) => output.push(args.join(' '));
    process.exit = code => { throw new Error(`unexpected exit: ${code}`); };
    await searchCommand(['zebraflow', '--raw']);
    assert.strictEqual(output.some(line => /atris\/MAP\.md:2/.test(line)), true);
  } finally {
    console.log = log;
    process.exit = exit;
    process.chdir(cwd);
    if (home === undefined) delete process.env.HOME;
    else process.env.HOME = home;
  }
});
