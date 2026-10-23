'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const savedEnv = {};
let tmpHome;
let nonFalsifyingIssue;

before(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-nonfalsifying-'));
  savedEnv.HOME = process.env.HOME;
  process.env.HOME = tmpHome;
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('ATRIS_')) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  }
  ({ nonFalsifyingIssue } = require('../lib/accept-verify-gate'));
});

after(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

test('flags each known hollow command with a message naming the command', () => {
  const hollow = ['git diff --check', 'git status', 'git log', 'git log --oneline -5', 'ls', 'ls -la test', 'true'];
  for (const command of hollow) {
    const issue = nonFalsifyingIssue(command);
    assert.strictEqual(
      issue,
      `\`${command}\` cannot fail for the reason this task exists, it passes on a commit that deletes the work`,
      command,
    );
  }
});

test('returns an empty string for commands that can actually fail', () => {
  const real = [
    'npm test',
    'node --test test/accept-verify-gate.test.js',
    'git diff --check HEAD~1',
    'git status --short',
    'git logs',
    'lsof -i',
    'trueish',
    'true && npm test',
    'grep -q needle file.txt',
  ];
  for (const command of real) {
    assert.strictEqual(nonFalsifyingIssue(command), '', command);
  }
});

test('trims surrounding whitespace before matching and in the message', () => {
  const issue = nonFalsifyingIssue('  \tgit diff --check \n');
  assert.ok(issue.startsWith('`git diff --check` cannot fail'), issue);
  assert.ok(!issue.includes('\n'));

  const spaced = nonFalsifyingIssue('git   diff    --check');
  assert.ok(spaced.startsWith('`git   diff    --check` cannot fail'), spaced);
});

test('matches case-insensitively and keeps the original casing in the message', () => {
  const issue = nonFalsifyingIssue('GIT Status');
  assert.ok(issue.startsWith('`GIT Status` cannot fail'), issue);
  assert.notStrictEqual(nonFalsifyingIssue('TRUE'), '');
  assert.notStrictEqual(nonFalsifyingIssue('LS -l'), '');
});

test('empty and whitespace-only input is not flagged', () => {
  assert.strictEqual(nonFalsifyingIssue(''), '');
  assert.strictEqual(nonFalsifyingIssue('   \n\t '), '');
});

test('non-string input throws instead of returning a verdict', () => {
  assert.throws(() => nonFalsifyingIssue(undefined), TypeError);
  assert.throws(() => nonFalsifyingIssue(null), TypeError);
});
