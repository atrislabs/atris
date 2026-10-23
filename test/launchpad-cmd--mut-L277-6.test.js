'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('a brain status without a next move asks for work', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'launchpad-no-move-'));
  const originalHome = process.env.HOME;
  const originalCwd = process.cwd();
  const originalLog = console.log;
  const originalExit = process.exit;
  const lines = [];

  try {
    process.env.HOME = root;
    process.chdir(root);
    fs.mkdirSync(path.join(root, 'atris', 'brain'), { recursive: true });
    fs.writeFileSync(path.join(root, 'atris', 'brain', 'STATUS.md'),
      '# Brain status\n\nNo next move has been compiled.\n');
    const { launchpadCommand } = require('../commands/launchpad');
    console.log = (...values) => lines.push(values.join(' '));
    process.exit = (code) => { throw new Error(`unexpected exit: ${code}`); };

    assert.equal(launchpadCommand(['--json']), 0);
    const result = JSON.parse(lines.join('\n'));
    assert.equal(result.brain.next_move, null);
    assert.equal(result.next_action.kind, 'ask_for_work');
    assert.equal(result.next_action.command, 'atris');
  } finally {
    console.log = originalLog;
    process.exit = originalExit;
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  }
});
