'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { launchpadCommand } = require('../commands/launchpad');

test('review preview contains only the task awaiting review', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-preview-'));
  const originalHome = process.env.HOME;
  const originalCwd = process.cwd();
  const originalLog = console.log;
  const originalExit = process.exit;
  const lines = [];
  try {
    process.env.HOME = root;
    process.chdir(root);
    fs.mkdirSync(path.join(root, 'atris'));
    fs.mkdirSync(path.join(root, '.atris', 'state'), { recursive: true });
    fs.writeFileSync(path.join(root, '.atris', 'state', 'tasks.projection.json'), JSON.stringify({
      tasks: [
        { id: 'task-open', title: 'Write usage guide', status: 'open' },
        { id: 'task-review', title: 'Check completed guide', status: 'review' },
      ],
    }));
    console.log = (...values) => lines.push(values.join(' '));
    process.exit = code => { throw new Error(`unexpected exit: ${code}`); };
    launchpadCommand(['--json', '--as', 'tester']);
    const result = JSON.parse(lines.join('\n'));
    assert.equal(result.previews.review.length, 1);
    assert.equal(result.previews.review[0].status, 'review');
  } finally {
    console.log = originalLog;
    process.exit = originalExit;
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  }
});
