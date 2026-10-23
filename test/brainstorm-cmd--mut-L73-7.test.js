'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { brainstormAtris } = require('../commands/brainstorm');

test('brainstorm prints the complete help when either help flag is used alone', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-brainstorm-help-'));
  const previousCwd = process.cwd();
  const previousArgv = process.argv;
  const previousLog = console.log;
  const expected = [
    '',
    'Usage: atris brainstorm "<idea>" [--json]',
    '',
    'Description:',
    "  Capture an idea to today's inbox and exit.",
    '  Never waits on a prompt. Headless.',
    '',
    'Options:',
    '  --json       Print a JSON receipt.',
    '  --cloud      Accepted. Capture stays local.',
    '  --no-cloud   Force local-only mode.',
    '  --yes        Accepted. Always non-interactive.',
    '',
  ].join('\n') + '\n';

  try {
    // If help falls through, keep all journal writes in this temporary workspace.
    fs.mkdirSync(path.join(dir, 'atris'));
    process.chdir(dir);
    for (const flag of ['--help', '-h']) {
      const lines = [];
      console.log = (...parts) => lines.push(parts.join(' '));
      process.argv = [process.execPath, 'atris', 'brainstorm', flag];
      await brainstormAtris();
      assert.equal(lines.join('\n') + '\n', expected, flag);
    }
  } finally {
    console.log = previousLog;
    process.argv = previousArgv;
    process.chdir(previousCwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
