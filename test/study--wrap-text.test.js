'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { wrapText } = require('../commands/study');

test('wrapText breaks normal text into lines no longer than the width', () => {
  const lines = wrapText('the quick brown fox jumps over the lazy dog', 15);
  assert.deepStrictEqual(lines, [
    'the quick brown',
    'fox jumps over',
    'the lazy dog',
  ]);
  for (const line of lines) assert.ok(line.length <= 15);
});

test('wrapText keeps short text on a single line', () => {
  assert.deepStrictEqual(wrapText('hello world', 60), ['hello world']);
});

test('wrapText defaults to 60 columns', () => {
  const words = Array.from({ length: 30 }, () => 'word');
  const lines = wrapText(words.join(' '));
  assert.ok(lines.length > 1);
  for (const line of lines) assert.ok(line.length <= 60);
  assert.strictEqual(lines[0].length, 59);
  assert.strictEqual(lines.join(' '), words.join(' '));
});

test('wrapText fits a line exactly at the width and wraps one past it', () => {
  assert.deepStrictEqual(wrapText('aaaa bbbb', 9), ['aaaa bbbb']);
  assert.deepStrictEqual(wrapText('aaaa bbbb', 8), ['aaaa', 'bbbb']);
});

test('wrapText collapses runs of spaces, tabs, and newlines', () => {
  assert.deepStrictEqual(
    wrapText('  one   two\n\nthree\tfour  ', 60),
    ['one two three four'],
  );
});

test('wrapText leaves a word longer than the width on its own line', () => {
  assert.deepStrictEqual(
    wrapText('hi supercalifragilistic yo', 10),
    ['hi', 'supercalifragilistic', 'yo'],
  );
});

test('wrapText returns one empty line for empty or missing input', () => {
  assert.deepStrictEqual(wrapText(''), ['']);
  assert.deepStrictEqual(wrapText('   \n\t '), ['']);
  assert.deepStrictEqual(wrapText(undefined), ['']);
  assert.deepStrictEqual(wrapText(null), ['']);
});

test('wrapText turns non-string input into text', () => {
  assert.deepStrictEqual(wrapText(12345), ['12345']);
});
