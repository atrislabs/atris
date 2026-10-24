'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { launchpadCommand } = require('../commands/launchpad');

test('an initialized workspace with no waiting work is not described as setup', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'repair-action-'));
  const cwd = process.cwd();
  const home = process.env.HOME;
  const log = console.log;
  const exit = process.exit;
  const write = process.stdout.write;
  const lines = [];
  try {
    process.env.HOME = root;
    fs.mkdirSync(path.join(root, '.atris', 'state'), { recursive: true });
    fs.mkdirSync(path.join(root, 'atris'));
    process.chdir(root);
    console.log = (...values) => lines.push(values.join(' '));
    process.stdout.write = chunk => { lines.push(String(chunk)); return true; };
    process.exit = code => { throw new Error(`unexpected exit: ${code}`); };
    launchpadCommand(['--as', 'codex']);
    assert.doesNotMatch(lines.join('\n'), /Set up/);
  } finally {
    process.stdout.write = write;
    process.exit = exit;
    console.log = log;
    process.chdir(cwd);
    if (home === undefined) delete process.env.HOME;
    else process.env.HOME = home;
  }
});
