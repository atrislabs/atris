'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { isEmptyProfile } = require('../lib/clarity');

test('each recognized answer makes a profile nonempty', () => {
  for (const key of ['focus', 'voice', 'cadence', 'done', 'leash']) {
    assert.strictEqual(isEmptyProfile({ [key]: 'an answer' }), false, key);
  }
  assert.strictEqual(isEmptyProfile({ focus: 'build tools', voice: 'plain' }), false);
});

test('missing profiles and profiles without answers are empty', () => {
  assert.strictEqual(isEmptyProfile(), true);
  assert.strictEqual(isEmptyProfile(null), true);
  assert.strictEqual(isEmptyProfile({}), true);
  assert.strictEqual(isEmptyProfile({ updated_at: '2025-01-01', unrelated: 'answer' }), true);
  assert.strictEqual(isEmptyProfile({
    focus: '', voice: false, cadence: 0, done: null, leash: undefined,
  }), true);
});

test('answer detection uses truthiness without trimming or requiring strings', () => {
  assert.strictEqual(isEmptyProfile({ focus: '   ' }), false);
  assert.strictEqual(isEmptyProfile({ voice: true }), false);
  assert.strictEqual(isEmptyProfile({ cadence: 1 }), false);
  assert.strictEqual(isEmptyProfile({ focus: '', leash: 'ask first' }), false);
});
