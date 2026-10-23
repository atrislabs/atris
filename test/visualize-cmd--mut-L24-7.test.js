'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const journal = require('../lib/journal');

test('an empty Inbox asks the user to add ideas', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-empty-inbox-'));
  const originalHome = process.env.HOME;
  const originalCwd = process.cwd();
  const originalLogPath = journal.getLogPath;
  const originalLog = console.log;
  const originalError = console.error;
  const originalExit = process.exit;
  const stopped = new Error('command stopped');
  const output = [];

  try {
    process.env.HOME = root;
    process.chdir(root);
    const logFile = path.join(root, 'journal.md');
    fs.writeFileSync(logFile, '## Inbox\n\n');
    // Fix the journal location before loading the command, without changing time.
    journal.getLogPath = () => ({ logFile });
    const { visualizeAtris } = require('../commands/visualize');
    journal.getLogPath = originalLogPath;
    console.log = console.error = (...args) => output.push(args.join(' '));
    process.exit = () => { throw stopped; };

    try {
      await visualizeAtris([]);
    } catch (error) {
      if (error !== stopped) throw error;
    }
    assert.match(output.join('\n'), /no items in inbox/i);
  } finally {
    journal.getLogPath = originalLogPath;
    console.log = originalLog;
    console.error = originalError;
    process.exit = originalExit;
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
