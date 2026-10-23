'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { zenCommand } = require('../commands/zen');

test('command reports a single unsaved team note in the singular', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-note-'));
  const home = process.env.HOME;
  const cwd = process.cwd();
  const log = console.log;
  const exit = process.exit;
  const lines = [];
  try {
    process.env.HOME = root;
    process.chdir(root);
    execFileSync('git', ['init', '-b', 'main'], { cwd: root, stdio: 'pipe' });
    fs.writeFileSync(path.join(root, 'AGENTS.md'), 'Speak plainly.\n');
    console.log = (...args) => lines.push(args.join(' '));
    process.exit = code => { throw new Error(`unexpected exit ${code}`); };
    zenCommand(['--no-fetch'], root);
    assert.match(lines.join('\n'), /1 unsaved team note\b(?!s)/i);
  } finally {
    console.log = log;
    process.exit = exit;
    process.chdir(cwd);
    if (home === undefined) delete process.env.HOME;
    else process.env.HOME = home;
  }
});
