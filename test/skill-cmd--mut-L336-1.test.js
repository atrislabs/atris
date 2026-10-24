'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { skillCommand, parseFrontmatter } = require('../commands/skill');

test('fix preserves legacy trigger phrases by merging them into the description', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-fix-triggers-'));
  const previousCwd = process.cwd();
  const previousHome = process.env.HOME;
  const previousLog = console.log;
  const previousError = console.error;
  const previousExit = process.exit;
  try {
    process.env.HOME = root;
    process.chdir(root);
    console.log = () => {};
    console.error = () => {};
    process.exit = (code) => { throw new Error(`unexpected exit: ${code}`); };
    const dir = path.join(root, 'atris', 'skills', 'daily-note');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'SKILL.md');
    fs.writeFileSync(file, [
      '---',
      'name: daily-note',
      'description: Write daily notes.',
      'triggers:',
      '  - daily journal',
      '  - morning notes',
      'version: 1.0.0',
      'tags: [notes]',
      '---',
      '# Daily notes',
      '1. Write a note.',
      ''
    ].join('\n'));

    skillCommand('fix', 'daily-note');

    const { description } = parseFrontmatter(fs.readFileSync(file, 'utf8'));
    assert.match(description, /daily journal/);
    assert.match(description, /morning notes/);
  } finally {
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    console.log = previousLog;
    console.error = previousError;
    process.exit = previousExit;
  }
});
