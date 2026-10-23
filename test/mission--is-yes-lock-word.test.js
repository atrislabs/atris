'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const scratchHome = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-mission-is-yes-lock-word-'));
test.after(() => {
  try {
    fs.rmSync(scratchHome, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
});

process.env.HOME = scratchHome;
for (const key of Object.keys(process.env)) {
  if (key.startsWith('ATRIS_')) {
    delete process.env[key];
  }
}

const { isYesLockWord } = require('../commands/mission');

test('identifies standard --yes-lock flags and filters argument lists', () => {
  assert.strictEqual(typeof isYesLockWord, 'function');

  // Exact flag match
  assert.strictEqual(isYesLockWord('--yes-lock'), true);

  // Key-value flag forms
  assert.strictEqual(isYesLockWord('--yes-lock='), true);
  assert.strictEqual(isYesLockWord('--yes-lock=inline-json'), true);
  assert.strictEqual(
    isYesLockWord('--yes-lock=[{"step":1,"text":"deploy","categories":["deploy"]}]'),
    true
  );

  // Other unrelated command-line arguments and flags return false
  assert.strictEqual(isYesLockWord('mission'), false);
  assert.strictEqual(isYesLockWord('start'), false);
  assert.strictEqual(isYesLockWord('--verify'), false);
  assert.strictEqual(isYesLockWord('--always-on'), false);

  // Filtering an argument array as used in commands/mission.js and commands/member.js
  const sampleArgs = [
    'mission',
    'start',
    'deploy application',
    '--owner',
    'mission-lead',
    '--yes-lock',
    '--verify',
    'npm test',
  ];
  const matched = sampleArgs.filter(isYesLockWord);
  assert.deepStrictEqual(matched, ['--yes-lock']);
});

test('handles edge cases including whitespace and prefix lookalikes', () => {
  // Trimming leading and trailing whitespace
  assert.strictEqual(isYesLockWord('  --yes-lock  '), true);
  assert.strictEqual(isYesLockWord('\t--yes-lock=value\n'), true);

  // Prefix lookalikes that do not have an equals sign
  assert.strictEqual(isYesLockWord('--yes-lock-parent'), false);
  assert.strictEqual(isYesLockWord('--yes-lock-parent=abc'), false);
  assert.strictEqual(isYesLockWord('--yes-locks'), false);
  assert.strictEqual(isYesLockWord('--yes-locking'), false);
  assert.strictEqual(isYesLockWord('--yes'), false);

  // Words containing --yes-lock elsewhere but not starting with it
  assert.strictEqual(isYesLockWord('prefix--yes-lock'), false);
  assert.strictEqual(isYesLockWord('--no--yes-lock'), false);
  assert.strictEqual(isYesLockWord('arg=--yes-lock'), false);
});

test('returns false for empty, falsy, and non-string inputs without throwing', () => {
  // Empty or whitespace-only strings
  assert.strictEqual(isYesLockWord(''), false);
  assert.strictEqual(isYesLockWord('   '), false);
  assert.strictEqual(isYesLockWord('\t\n'), false);

  // Null, undefined, and boolean values
  assert.strictEqual(isYesLockWord(null), false);
  assert.strictEqual(isYesLockWord(undefined), false);
  assert.strictEqual(isYesLockWord(false), false);
  assert.strictEqual(isYesLockWord(true), false);

  // Numbers and objects
  assert.strictEqual(isYesLockWord(0), false);
  assert.strictEqual(isYesLockWord(123), false);
  assert.strictEqual(isYesLockWord(NaN), false);
  assert.strictEqual(isYesLockWord({}), false);
  assert.strictEqual(isYesLockWord([]), false);
});
