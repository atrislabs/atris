'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('persona preview preserves its last character at the display limit', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-preview-boundary-'));
  const previousHome = process.env.HOME;
  const previousCwd = process.cwd();
  const previousLog = console.log;
  const previousExit = process.exit;
  const lines = [];
  const preview = 'Speak plainly and keep replies warm';

  try {
    process.env.HOME = root;
    process.chdir(root);
    fs.mkdirSync(path.join(root, 'atris'));
    fs.writeFileSync(path.join(root, 'atris', 'PERSONA.md'), preview);
    console.log = (...args) => lines.push(args.join(' '));
    process.exit = (code) => { throw new Error(`unexpected exit: ${code}`); };
    const { soul } = require('../commands/soul');
    soul([]);

    const personaLine = lines.find(line => line.includes('persona:')) || '';
    assert.ok(personaLine.includes(preview));
  } finally {
    console.log = previousLog;
    process.exit = previousExit;
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
