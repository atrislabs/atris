'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyVerifier } = require('../lib/verifier-quality');

test('a custom verification script is not classified as a content search', () => {
  assert.strictEqual(classifyVerifier('node scripts/verify.js').kind, 'unknown');
});
