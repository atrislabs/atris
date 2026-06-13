'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const escapeRegExp = require('../lib/escape-regexp');
const verify = require('../commands/verify');
const brain = require('../commands/brain');

test('escapeRegExp escapes every regex metacharacter', () => {
  assert.equal(escapeRegExp('a.b'), 'a\\.b');
  assert.equal(escapeRegExp('('), '\\(');
  assert.equal(escapeRegExp('c++'), 'c\\+\\+');
  assert.equal(escapeRegExp('a[b]c{d}e'), 'a\\[b\\]c\\{d\\}e');
  assert.equal(escapeRegExp('^$|?*'), '\\^\\$\\|\\?\\*');
});

test('escapeRegExp coerces non-strings instead of throwing', () => {
  assert.equal(escapeRegExp(42), '42');
  assert.equal(escapeRegExp(null), 'null');
  assert.equal(escapeRegExp(undefined), 'undefined');
});

test('escaped output, embedded in a RegExp, matches the literal source string', () => {
  for (const raw of ['a.b', 'c++', '(x)', 'a|b', 'q?']) {
    const re = new RegExp(`^${escapeRegExp(raw)}$`);
    assert.ok(re.test(raw), `escaped "${raw}" should match itself literally`);
  }
});

test('verify and brain re-export the same shared escaper instance', () => {
  // Migrated consumers route through lib/escape-regexp; the dedicated test files
  // import escapeRegExp from these modules, so the identity must hold.
  assert.equal(verify.escapeRegExp, escapeRegExp);
  assert.equal(brain.escapeRegExp, escapeRegExp);
});
