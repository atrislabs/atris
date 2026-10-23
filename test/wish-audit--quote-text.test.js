'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { quoteText } = require('../lib/wish-audit');

test('quoteText wraps ordinary text and preserves whitespace and unicode', () => {
  assert.strictEqual(quoteText('node --test'), '"node --test"');
  assert.strictEqual(quoteText('  café ☕  '), '"  café ☕  "');
});

test('quoteText escapes quotes, backslashes, and control characters', () => {
  assert.strictEqual(quoteText('say "hello"'), '"say \\"hello\\""');
  assert.strictEqual(quoteText('a\\b\nc\td\r\u0000'), '"a\\\\b\\nc\\td\\r\\u0000"');
});

test('quoteText returns quoted empty text for missing and falsy inputs', () => {
  assert.strictEqual(quoteText(), '""');
  for (const value of ['', undefined, null, false, 0, NaN]) {
    assert.strictEqual(quoteText(value), '""');
  }
});

test('quoteText converts truthy values to text before quoting', () => {
  assert.strictEqual(quoteText(42), '"42"');
  assert.strictEqual(quoteText(true), '"true"');
  assert.strictEqual(quoteText({ toString: () => 'custom "text"' }), '"custom \\"text\\""');
});

test('quoteText propagates an error from string conversion', () => {
  const error = new Error('cannot convert to text');
  const value = { toString() { throw error; } };
  assert.throws(() => quoteText(value), (actual) => actual === error);
});
