'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { isParkedFrontmatter } = require('../lib/member-park');

test('recognizes parked status and rejects other statuses', () => {
  assert.strictEqual(isParkedFrontmatter({ status: 'parked' }), true);
  assert.strictEqual(isParkedFrontmatter({ status: 'active' }), false);
  assert.strictEqual(isParkedFrontmatter({ status: 'unparked' }), false);
  assert.strictEqual(isParkedFrontmatter({ status: 'parked temporarily' }), false);
});

test('ignores surrounding whitespace and letter case', () => {
  assert.strictEqual(isParkedFrontmatter({ status: ' \tPaRkEd\r\n' }), true);
  assert.strictEqual(isParkedFrontmatter({ status: 'par ked' }), false);
});

test('returns false for missing or empty frontmatter and status', () => {
  for (const frontmatter of [undefined, null, {}, { status: undefined },
    { status: null }, { status: '' }, { status: ' \t\n' }]) {
    assert.strictEqual(isParkedFrontmatter(frontmatter), false);
  }
});

test('handles non-string status values through string conversion', () => {
  assert.strictEqual(isParkedFrontmatter({ status: false }), false);
  assert.strictEqual(isParkedFrontmatter({ status: 0 }), false);
  assert.strictEqual(isParkedFrontmatter({ status: 42 }), false);
  assert.strictEqual(isParkedFrontmatter({ status: ['parked'] }), true);
});
