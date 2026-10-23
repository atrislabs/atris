'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { collectSearchResults } = require('../commands/search');

test('a source filename match is returned even when its contents do not match', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-search-path-only-'));
  const originalHome = process.env.HOME;
  const originalCwd = process.cwd();
  try {
    process.env.HOME = root;
    process.chdir(root);
    fs.mkdirSync(path.join(root, 'lib'));
    fs.writeFileSync(path.join(root, 'lib', 'orchard.js'), 'module.exports = 42;\n');

    const result = collectSearchResults(root, 'orchard');

    assert.strictEqual(
      result.layers.source.fileHits.some(hit => hit.file === 'lib/orchard.js'),
      true
    );
  } finally {
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  }
});
