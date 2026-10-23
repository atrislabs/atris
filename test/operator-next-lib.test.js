'use strict';

// printOperatorNext prints the one command an operator should copy next.
// These tests pin the exact printed line, the label option, and the silent
// path for empty input. console.log is captured so nothing reaches the runner.

const { test } = require('node:test');
const assert = require('node:assert');
const { printOperatorNext } = require('../lib/operator-next');

function captureLog(fn) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    fn();
  } finally {
    console.log = original;
  }
  return lines;
}

test('prints the trimmed command with the default "Next" label', () => {
  const lines = captureLog(() => printOperatorNext('  atris land --reap  '));
  assert.deepEqual(lines, ['Next: atris land --reap']);
});

test('a custom label replaces "Next" and keeps the command text as-is', () => {
  const lines = captureLog(() =>
    printOperatorNext('atris task render --out atris/TODO.md', { label: 'Run' }));
  assert.deepEqual(lines, ['Run: atris task render --out atris/TODO.md']);
});

test('empty, whitespace-only, null, and undefined commands print nothing', () => {
  const lines = captureLog(() => {
    printOperatorNext('');
    printOperatorNext('   \t  ');
    printOperatorNext(null);
    printOperatorNext(undefined);
  });
  assert.deepEqual(lines, []);
});

test('a non-string command is coerced to text before printing', () => {
  const lines = captureLog(() => printOperatorNext(42));
  assert.deepEqual(lines, ['Next: 42']);
});

test('only the outer whitespace is trimmed; inner spacing survives', () => {
  const lines = captureLog(() => printOperatorNext('  npm   test  '));
  assert.deepEqual(lines, ['Next: npm   test']);
});
