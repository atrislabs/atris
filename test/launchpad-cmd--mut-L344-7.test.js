'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { launchpadCommand } = require('../commands/launchpad');

test('the first task suggestion uses the endgame horizon as its subject', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'subject-test-'));
  const cwd = process.cwd();
  const home = process.env.HOME;
  const log = console.log;
  const lines = [];
  try {
    process.env.HOME = root;
    process.chdir(root);
    fs.mkdirSync(path.join(root, 'atris'));
    fs.writeFileSync(path.join(root, 'atris', 'TODO.md'), '# Tasks\n\n## Endgame\n\n**Slug:** publish-guide\n\n**Horizon:** Publish the user guide\n');
    console.log = (...args) => lines.push(args.join(' '));
    launchpadCommand(['--json']);
    const state = JSON.parse(lines.join('\n'));
    assert.equal(state.suggestions[0].subject, 'Publish the user guide');
  } finally {
    console.log = log;
    process.chdir(cwd);
    if (home === undefined) delete process.env.HOME;
    else process.env.HOME = home;
  }
});
