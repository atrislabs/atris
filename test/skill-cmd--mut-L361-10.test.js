'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { skillCommand, parseFrontmatter } = require('../commands/skill');

test('fixing a missing version preserves every item in an existing tag list', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-version-tags-'));
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
      'description: Use when writing daily notes.',
      'name: daily-note',
      'tags:',
      '  - notes',
      '  - daily',
      '---',
      '',
      '# Daily note',
      '',
      '1. Write a note.',
      ''
    ].join('\n'));

    skillCommand('fix', 'daily-note');

    const repaired = parseFrontmatter(fs.readFileSync(file, 'utf8'));
    assert.equal(repaired.tags.includes('daily'), true);
  } finally {
    console.log = previousLog;
    console.error = previousError;
    process.exit = previousExit;
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
