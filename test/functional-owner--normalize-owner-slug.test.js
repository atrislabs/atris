'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { normalizeOwnerSlug } = require('../lib/functional-owner');

test('normalizes owner names and preserves existing slugs', () => {
  assert.strictEqual(normalizeOwnerSlug('  Task Planner  '), 'task-planner');
  assert.strictEqual(normalizeOwnerSlug('mission-lead'), 'mission-lead');
  assert.strictEqual(normalizeOwnerSlug('Owner 42'), 'owner-42');
});

test('collapses punctuation and whitespace and removes boundary separators', () => {
  assert.strictEqual(normalizeOwnerSlug('__Wiki...MINER / Team--2!!'), 'wiki-miner-team-2');
  assert.strictEqual(normalizeOwnerSlug('\tSignal\nScout\r\n'), 'signal-scout');
  assert.strictEqual(normalizeOwnerSlug('caf\u00e9 owner'), 'caf-owner');
});

test('returns an empty slug for missing, falsy, or separator-only input', () => {
  for (const value of [undefined, null, '', false, 0, NaN, ' \t\n ', '___!!!', '\u65e5\u672c']) {
    assert.strictEqual(normalizeOwnerSlug(value), '');
  }
  assert.strictEqual(normalizeOwnerSlug(), '');
});

test('converts truthy non-string input before normalization', () => {
  assert.strictEqual(normalizeOwnerSlug(123), '123');
  assert.strictEqual(normalizeOwnerSlug(true), 'true');
});
