'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { nextCommand } = require('../commands/next');

test('an initialized workspace reports a successful next step', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-skip-ready-'));
  const cwd = process.cwd();
  const home = process.env.HOME;
  const exit = process.exit;
  const log = console.log;
  const lines = [];
  try {
    process.env.HOME = root;
    process.chdir(root);
    process.exit = (code) => { throw new Error(`unexpected exit: ${code}`); };
    console.log = (line) => lines.push(String(line));
    fs.mkdirSync(path.join(root, 'atris'));
    fs.writeFileSync(path.join(root, 'atris', 'MAP.md'), '# Map\n');
    fs.writeFileSync(path.join(root, 'atris', 'TODO.md'), '# TODO\n\n## Backlog\n\n(Empty)\n');
    nextCommand(['--json'], root);
    const result = JSON.parse(lines.join('\n'));
    assert.equal(result.ok, true);
  } finally {
    console.log = log;
    process.exit = exit;
    process.chdir(cwd);
    if (home === undefined) delete process.env.HOME;
    else process.env.HOME = home;
  }
});
