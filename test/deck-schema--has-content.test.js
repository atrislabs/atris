'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { hasContent } = require('../lib/deck-schema');

test('hasContent returns true for values a slide field would carry', () => {
  assert.equal(hasContent('title'), true);
  assert.equal(hasContent(['a', 'b']), true);
  assert.equal(hasContent({ rows: [] }), true);
  assert.equal(hasContent(42), true);
  assert.equal(hasContent(true), true);
});

test('hasContent returns false for empty and missing values', () => {
  assert.equal(hasContent(null), false);
  assert.equal(hasContent(undefined), false);
  assert.equal(hasContent(''), false);
  assert.equal(hasContent([]), false);
  assert.equal(hasContent({}), false);
  assert.equal(hasContent(false), false);
});

test('hasContent trims strings so whitespace-only text counts as empty', () => {
  assert.equal(hasContent('   '), false);
  assert.equal(hasContent('\t\n'), false);
  assert.equal(hasContent('  x  '), true);
});

test('hasContent treats zero and NaN by their real truthiness rules', () => {
  assert.equal(hasContent(0), true);
  assert.equal(hasContent('0'), true);
  assert.equal(hasContent(NaN), false);
});
