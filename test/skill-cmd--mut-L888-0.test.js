'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { skillCommand } = require('../commands/skill');

test('link reports already linked when targets are already linked', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-test-'));
  const previousCwd = process.cwd();
  const previousHome = process.env.HOME;
  const previousLog = console.log;
  const output = [];

  try {
    process.chdir(root);
    process.env.HOME = root;
    console.log = (...args) => output.push(args.join(' '));

    const skillDir = path.join(root, 'atris', 'skills', 'demo');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: demo\n---\n');

    skillCommand('link', 'demo');
    output.length = 0;

    skillCommand('link', 'demo');
  } finally {
    console.log = previousLog;
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(root, { recursive: true, force: true });
  }

  assert.ok(output.some((line) => line.includes('already linked')));
});
