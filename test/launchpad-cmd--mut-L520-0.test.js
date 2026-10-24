'use strict';
require('./helpers/clean-temp');

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { launchpadCommand } = require('../commands/launchpad');

test('an initialized workspace without queued work advises rerunning the command', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'next-step-'));
  const cwd = process.cwd();
  const home = process.env.HOME;
  const log = console.log;
  const write = process.stdout.write;
  const exit = process.exit;
  const output = [];
  try {
    process.env.HOME = root;
    fs.mkdirSync(path.join(root, '.atris', 'state'), { recursive: true });
    fs.mkdirSync(path.join(root, 'atris'));
    process.chdir(root);
    console.log = (...values) => output.push(values.join(' '));
    process.stdout.write = chunk => { output.push(String(chunk)); return true; };
    process.exit = code => { throw new Error(`unexpected exit: ${code}`); };
    launchpadCommand(['--as', 'codex']);
    const after = output.join('\n').split('AFTER THAT')[1].split('BEHIND THIS')[0];
    assert.match(after, /rerun/);
  } finally {
    process.exit = exit;
    process.stdout.write = write;
    console.log = log;
    process.chdir(cwd);
    if (home === undefined) delete process.env.HOME;
    else process.env.HOME = home;
  }
});
