'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { zenCommand } = require('../commands/zen');

test('a fleet safely skipped for unsaved secrets returns success', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-fleet-exit-'));
  const originalHome = process.env.HOME;
  const originalCwd = process.cwd();
  const originalLog = console.log;
  try {
    process.env.HOME = root;
    process.chdir(root);
    execFileSync('git', ['init', '--quiet', root]);
    fs.writeFileSync(path.join(root, '.env'), 'API_TOKEN=local-example\n');
    console.log = () => {};
    assert.equal(zenCommand(['--all', '--no-fetch', '--json', root], root), 0);
  } finally {
    console.log = originalLog;
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  }
});
