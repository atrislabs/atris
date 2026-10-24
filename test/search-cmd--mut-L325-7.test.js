'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { searchCommand } = require('../commands/search');

test('source content hits are shown in a folder without workspace notes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-search-content-'));
  const originalHome = process.env.HOME;
  const originalCwd = process.cwd();
  const originalLog = console.log;
  const originalExit = process.exit;
  const logs = [];
  try {
    process.env.HOME = root;
    process.chdir(root);
    console.log = (...args) => logs.push(args.join(' '));
    process.exit = code => { throw new Error(`unexpected exit: ${code}`); };
    fs.mkdirSync(path.join(root, 'lib'));
    fs.writeFileSync(path.join(root, 'lib', 'catalog.js'), 'module.exports = "orchard";\n');

    searchCommand(['orchard'], { root });

    assert.strictEqual(logs.some(line => line.includes('lib/catalog.js')), true);
  } finally {
    console.log = originalLog;
    process.exit = originalExit;
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  }
});
