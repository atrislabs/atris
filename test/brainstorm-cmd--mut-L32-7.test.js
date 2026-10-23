'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { brainstormAtris } = require('../commands/brainstorm');

test('brainstorm reports the journal path relative to the workspace', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brainstorm-relative-'));
  const originalCwd = process.cwd();
  const originalArgv = process.argv;
  const OriginalDate = global.Date;
  const originalLog = console.log;
  const lines = [];
  try {
    fs.mkdirSync(path.join(root, 'atris'));
    process.chdir(root);
    process.argv = [process.execPath, 'atris', 'brainstorm'];
    // Fix the local calendar day, independently of the host date and time zone.
    global.Date = class extends OriginalDate {
      constructor(...args) {
        if (args.length) super(...args);
        else super(2001, 1, 3, 12, 0, 0);
      }
    };
    console.log = (...args) => lines.push(args.join(' '));

    await brainstormAtris();

    assert.deepEqual(lines, [
      'brainstorm captures an idea on the command line and exits.',
      `journal: ${path.join('atris', 'logs', '2001', '2001-02-03.md')}`,
      'Next: atris brainstorm "<idea>"',
    ]);
  } finally {
    console.log = originalLog;
    global.Date = OriginalDate;
    process.argv = originalArgv;
    process.chdir(originalCwd);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
