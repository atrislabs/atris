'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { skillCommand } = require('../commands/skill');

const ANSI = /\x1b\[[0-9;]*m/g;

function writeSkill(root, folder, bodyLines) {
  const dir = path.join(root, 'atris', 'skills', folder);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), [
    '---',
    `name: ${folder}`,
    'description: Fixture skill. Use when testing.',
    'version: 1.0.0',
    'tags: [test]',
    '---',
    '',
    '# Fixture',
    '',
    ...bodyLines,
    ''
  ].join('\n'));
}

function listOutput() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-list-status-'));
  const previousCwd = process.cwd();
  const previousHome = process.env.HOME;
  const previousLog = console.log;
  const previousExit = process.exit;
  const output = [];
  try {
    process.chdir(root);
    process.env.HOME = root;
    console.log = (...args) => output.push(args.join(' '));
    process.exit = () => { throw new Error('unexpected exit'); };

    writeSkill(root, 'mut-alpha', ['1. Step one.', '2. Step two.']);
    writeSkill(root, 'mut-beta', ['1. Wrap output in <answer>...</answer> tags.']);

    skillCommand('list');
  } finally {
    console.log = previousLog;
    process.exit = previousExit;
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
  return output.map((line) => line.replace(ANSI, ''));
}

test('list shows PASS for a clean skill and FAIL for one with a failed check', () => {
  const output = listOutput();
  const alphaRow = output.find((line) => line.includes('mut-alpha'));
  const betaRow = output.find((line) => line.includes('mut-beta'));

  assert.equal(alphaRow.trim().split(/\s+/).pop(), 'PASS');
  assert.equal(betaRow.trim().split(/\s+/).pop(), 'FAIL');
});
