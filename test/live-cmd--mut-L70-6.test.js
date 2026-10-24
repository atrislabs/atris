require('./helpers/clean-temp');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseLiveOptions } = require('../commands/live');

test('a business without a local folder keeps the working folder', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-business-file-'));
  const previousHome = process.env.HOME;
  const previousCwd = process.cwd();
  try {
    process.env.HOME = root;
    process.chdir(root);
    const options = parseLiveOptions(['acme', '--once'], root);
    assert.strictEqual(options.cwd, root);
  } finally {
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
