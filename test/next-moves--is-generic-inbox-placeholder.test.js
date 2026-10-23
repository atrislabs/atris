'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { isGenericInboxPlaceholder } = require('../lib/next-moves');

test('isGenericInboxPlaceholder flags every known placeholder title', () => {
  const placeholders = [
    'dogfood tick',
    'autopilot tick',
    'mission tick',
    'run tick',
    'run one tick',
    'tick',
    'test idea',
    'sample idea',
    'placeholder idea',
    'idea',
    'todo',
    'tbd',
  ];
  for (const title of placeholders) {
    assert.strictEqual(isGenericInboxPlaceholder(title), true, `expected "${title}" to be flagged`);
  }
});

test('isGenericInboxPlaceholder ignores case and stray whitespace', () => {
  assert.strictEqual(isGenericInboxPlaceholder('AUTOPILOT TICK'), true);
  assert.strictEqual(isGenericInboxPlaceholder('  Mission   Tick  '), true);
  assert.strictEqual(isGenericInboxPlaceholder('\tTBD\n'), true);
});

test('isGenericInboxPlaceholder strips a leading title: prefix', () => {
  assert.strictEqual(isGenericInboxPlaceholder('Title: idea'), true);
  assert.strictEqual(isGenericInboxPlaceholder('title: todo'), true);
});

test('isGenericInboxPlaceholder leaves real titles alone', () => {
  const realTitles = [
    'fix the login redirect',
    'tickets',
    'todo list cleanup',
    'the big idea',
    'run tickets daily',
    'tick tock',
  ];
  for (const title of realTitles) {
    assert.strictEqual(isGenericInboxPlaceholder(title), false, `expected "${title}" to pass through`);
  }
});

test('isGenericInboxPlaceholder returns false for empty and missing input', () => {
  assert.strictEqual(isGenericInboxPlaceholder(''), false);
  assert.strictEqual(isGenericInboxPlaceholder('   '), false);
  assert.strictEqual(isGenericInboxPlaceholder('title:'), false);
  assert.strictEqual(isGenericInboxPlaceholder(null), false);
  assert.strictEqual(isGenericInboxPlaceholder(undefined), false);
});
