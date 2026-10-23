'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { applySlug } = require('../lib/apply-gate');

test('applySlug lowercases text and collapses separators', () => {
  assert.strictEqual(applySlug('  Apply THIS: release_42 / notes!  '), 'apply-this-release-42-notes');
  assert.strictEqual(applySlug('already-a-slug-123'), 'already-a-slug-123');
});

test('applySlug limits normalized output to 48 characters', () => {
  assert.strictEqual(applySlug('A'.repeat(60)), 'a'.repeat(48));
  assert.strictEqual(applySlug('A'.repeat(47) + ' B'), 'a'.repeat(47) + '-');
  assert.strictEqual(applySlug('A'.repeat(48)), 'a'.repeat(48));
});

test('applySlug falls back to query when no slug characters remain', () => {
  for (const input of [undefined, null, '', '   ', '!!!___---', '你好']) {
    assert.strictEqual(applySlug(input), 'query');
  }
});

test('applySlug coerces truthy non-string values before normalization', () => {
  assert.strictEqual(applySlug(12345), '12345');
  assert.strictEqual(applySlug(true), 'true');
  assert.strictEqual(applySlug(0), 'query');
});
