'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { zenCommand, showZenHelp } = require('../commands/zen');

function captureLog(fn) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    return { value: fn(), lines };
  } finally {
    console.log = original;
  }
}

test('showZenHelp describes usage and the read-only and fleet options', () => {
  const { lines } = captureLog(() => showZenHelp());
  assert.strictEqual(lines[0], 'usage: atris zen [--check] [--no-fetch] [--json]');
  assert.strictEqual(lines[1], '       atris zen --all [repo ...]');
  assert.ok(lines.includes('  --check      Only look. Report what is out of place and change nothing.'));
  assert.ok(lines.includes('  --no-fetch   Use the last fetched origin instead of fetching.'));
  assert.ok(lines.includes('  --json       Print machine-readable results.'));
});

test('help aliases return success and take precedence over operational flags', () => {
  const expected = captureLog(() => showZenHelp()).lines;
  for (const args of [
    ['--help'],
    ['-h'],
    ['help'],
    ['--all', '--check', '--json', '--help'],
    ['--check', '-h'],
    ['help', '--all'],
  ]) {
    // An unusable cwd makes accidental entry into repository operations visible.
    const result = captureLog(() => zenCommand(args, __filename));
    assert.strictEqual(result.value, 0, JSON.stringify(args));
    assert.deepStrictEqual(result.lines, expected, JSON.stringify(args));
  }
});
