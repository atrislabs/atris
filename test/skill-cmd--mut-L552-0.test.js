'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { skillCommand, parseFrontmatter } = require('../commands/skill');

test('fix all adds missing metadata to every local skill', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-fix-all-'));
  const previous = { cwd: process.cwd(), home: process.env.HOME, log: console.log,
    error: console.error, exit: process.exit };
  const exitSignal = new Error('intercepted exit');
  try {
    process.chdir(root);
    process.env.HOME = root;
    console.log = console.error = () => {};
    process.exit = () => { throw exitSignal; };
    const files = ['daily-note', 'weekly-note'].map((name) => {
      const dir = path.join(root, 'atris', 'skills', name);
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'SKILL.md');
      fs.writeFileSync(file, `---\nname: ${name}\ndescription: Use when taking notes.\n---\n\n1. Write a note.\n`);
      return file;
    });
    try {
      skillCommand('fix', '--all');
    } catch (error) {
      if (error !== exitSignal) throw error;
    }
    assert.equal(parseFrontmatter(fs.readFileSync(files[0], 'utf8')).version, '1.0.0');
    assert.equal(parseFrontmatter(fs.readFileSync(files[1], 'utf8')).version, '1.0.0');
  } finally {
    process.chdir(previous.cwd);
    if (previous.home === undefined) delete process.env.HOME;
    else process.env.HOME = previous.home;
    console.log = previous.log;
    console.error = previous.error;
    process.exit = previous.exit;
  }
});
