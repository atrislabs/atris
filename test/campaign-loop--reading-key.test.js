'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { readingKey } = require('../lib/campaign-loop');

test('readingKey builds a stable key for a normal judge reading', () => {
  const key = readingKey(true, 0.5, 'halfway there');
  assert.strictEqual(key, JSON.stringify([true, 0.5, 'halfway there']));
  // Same inputs always produce the same key, so a repeated reading is detected.
  assert.strictEqual(key, readingKey(true, 0.5, 'halfway there'));
});

test('readingKey changes when pass state, reading, or summary differs', () => {
  const base = readingKey(true, 0.5, 'same words');
  assert.notStrictEqual(readingKey(false, 0.5, 'same words'), base);
  assert.notStrictEqual(readingKey(true, 0.6, 'same words'), base);
  assert.notStrictEqual(readingKey(true, 0.5, 'other words'), base);
});

test('readingKey normalizes non-boolean, non-number, and empty inputs', () => {
  // A truthy non-boolean passed flag collapses to true.
  assert.strictEqual(readingKey(1, 3, 'ok'), readingKey(true, 3, 'ok'));
  // A non-number reading is stored as null, not coerced.
  assert.strictEqual(readingKey(true, '0.5', 'ok'), JSON.stringify([true, null, 'ok']));
  assert.strictEqual(readingKey(true, undefined, 'ok'), JSON.stringify([true, null, 'ok']));
  // Empty or missing summary is stored as null.
  assert.strictEqual(readingKey(false, 2, ''), JSON.stringify([false, 2, null]));
  assert.strictEqual(readingKey(false, 2, null), readingKey(false, 2, ''));
});
