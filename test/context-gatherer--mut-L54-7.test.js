'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isFlagLikeAnswer } = require('../lib/context-gatherer');

test('multiple flag-like tokens including bare help are a flag-like answer', () => {
  assert.strictEqual(isFlagLikeAnswer('--json help'), true);
});
