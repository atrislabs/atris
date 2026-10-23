'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { normalizeSnippet } = require('../lib/security-scan');

test('normalizeSnippet collapses whitespace and preserves snippet content', () => {
  assert.strictEqual(normalizeSnippet('  const\tvalue =\n  "Hello"; \r\n'), 'const value = "Hello";');
  assert.strictEqual(normalizeSnippet('Already normalized!'), 'Already normalized!');
});

test('normalizeSnippet handles Unicode whitespace and adjacent text', () => {
  assert.strictEqual(normalizeSnippet('\u00a0alpha\u2003\u2028beta\ufeff'), 'alpha beta');
  assert.strictEqual(normalizeSnippet('café/東京:value'), 'café/東京:value');
});

test('normalizeSnippet returns an empty string for empty and falsy inputs', () => {
  assert.strictEqual(normalizeSnippet(), '');
  for (const input of ['', ' \t\r\n ', null, undefined, false, 0, NaN]) {
    assert.strictEqual(normalizeSnippet(input), '');
  }
});

test('normalizeSnippet converts truthy non-string inputs before normalizing', () => {
  assert.strictEqual(normalizeSnippet(42), '42');
  assert.strictEqual(normalizeSnippet(true), 'true');
  assert.strictEqual(normalizeSnippet({ toString: () => '  custom\n snippet  ' }), 'custom snippet');
});
