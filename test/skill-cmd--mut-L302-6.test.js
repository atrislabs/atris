'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { skillCommand } = require('../commands/skill');

test('list reports PASS when every check passes, including ERROR severity checks', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-list-pass-'));
  const previousCwd = process.cwd();
  const previousHome = process.env.HOME;
  const previousLog = console.log;
  const output = [];

  try {
    process.chdir(root);
    process.env.HOME = root;
    const dir = path.join(root, 'atris', 'skills', 'fixture');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), [
      '---',
      'name: fixture',
      'description: Use when testing.',
      'version: 1.0.0',
      'tags: [test]',
      '---',
      '',
      '1. Run the check.',
      ''
    ].join('\n'));

    console.log = (...args) => output.push(args.join(' '));
    skillCommand('list');

    assert.deepEqual(
      output.filter(line => /^  fixture\s/.test(line)),
      ['  fixture            1.0.0      12/12    PASS']
    );
  } finally {
    console.log = previousLog;
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
