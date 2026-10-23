const test = require('node:test');
const assert = require('node:assert/strict');

const { firstTalkBuildCommand } = require('../lib/first-minute');

const INSTALL_LINE = 'npm install -g @anthropic-ai/claude-code';

test('firstTalkBuildCommand wraps the want in a quoted builder call', () => {
  assert.equal(
    firstTalkBuildCommand('claude', 'make a landing page'),
    'claude "make a landing page"',
  );
  assert.equal(
    firstTalkBuildCommand('codex', 'fix the login bug'),
    'codex "fix the login bug"',
  );
});

test('firstTalkBuildCommand collapses whitespace and trims the want', () => {
  assert.equal(
    firstTalkBuildCommand('cursor-agent', '  build   the\n  thing '),
    'cursor-agent "build the thing"',
  );
});

test('firstTalkBuildCommand escapes quotes, backslashes, dollars, and backticks', () => {
  assert.equal(
    firstTalkBuildCommand('claude', 'say "hi" $HOME `whoami` a\\b'),
    'claude "say \\"hi\\" \\$HOME \\`whoami\\` a\\\\b"',
  );
});

test('firstTalkBuildCommand returns the install line when no builder is installed', () => {
  assert.equal(firstTalkBuildCommand(null, 'make a landing page'), INSTALL_LINE);
  assert.equal(firstTalkBuildCommand('', 'make a landing page'), INSTALL_LINE);
  assert.equal(firstTalkBuildCommand(false, 'make a landing page'), INSTALL_LINE);
});

test('firstTalkBuildCommand returns empty when the builder probe is skipped', () => {
  assert.equal(firstTalkBuildCommand(undefined, 'make a landing page'), '');
  assert.equal(firstTalkBuildCommand(), '');
});

test('firstTalkBuildCommand handles empty and non-string wants', () => {
  assert.equal(firstTalkBuildCommand('claude', ''), 'claude ""');
  assert.equal(firstTalkBuildCommand('claude'), 'claude ""');
  assert.equal(firstTalkBuildCommand('claude', 42), 'claude "42"');
});
