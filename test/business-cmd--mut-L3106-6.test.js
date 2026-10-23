'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('connect preserves the chosen business when a repeated flag has no value', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-connect-flags-'));
  const originalHome = process.env.HOME;
  const originalCwd = process.cwd();
  const originalLog = console.log;
  const originalExit = process.exit;
  const lines = [];

  try {
    process.env.HOME = home;
    process.chdir(home);
    const { businessCommand } = require('../commands/business');
    const connector = 'mutation-local-connector';
    const skillDir = path.join(home, '.claude', 'skills', connector);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# Local connector\n');
    console.log = (...args) => lines.push(args.join(' '));
    process.exit = code => { throw new Error(`unexpected exit: ${code}`); };

    await businessCommand('connect', connector, '--business', 'chosen-shop', '--business');

    const businessLine = lines.find(line => /\bBusiness:/.test(line));
    assert.equal(businessLine?.split(':').slice(1).join(':').trim(), 'chosen-shop');
  } finally {
    console.log = originalLog;
    process.exit = originalExit;
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  }
});
