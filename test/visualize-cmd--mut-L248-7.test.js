'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('default image filename keeps the prompt slug', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-visual-slug-'));
  const cwd = process.cwd();
  const home = process.env.HOME;
  const log = console.log;
  const lines = [];
  try {
    process.env.HOME = root;
    process.chdir(root);
    console.log = (...args) => lines.push(args.join(' '));
    const { visualizeAtris } = require('../commands/visualize');
    await visualizeAtris(['Customer', 'Onboarding', '--dry-run', '--raw']);
    const output = lines.find(line => /^Output:/.test(line));
    const filename = path.basename((output || '').replace(/^Output:\s*/, ''));
    assert.strictEqual(filename.startsWith('customer-onboarding-'), true);
  } finally {
    console.log = log;
    process.chdir(cwd);
    if (home === undefined) delete process.env.HOME;
    else process.env.HOME = home;
  }
});
