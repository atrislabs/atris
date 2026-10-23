'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { rosterJobLabel } = require('../lib/engine-registry');

test('rosterJobLabel translates built-in role keys into job names', () => {
  assert.strictEqual(rosterJobLabel('navigator'), 'search');
  assert.strictEqual(rosterJobLabel('executor'), 'build');
  assert.strictEqual(rosterJobLabel('validator'), 'review');
});

test('rosterJobLabel displays custom keys with every hyphen replaced', () => {
  assert.strictEqual(rosterJobLabel('small-build'), 'small build');
  assert.strictEqual(rosterJobLabel('deep-code-review'), 'deep code review');
  assert.strictEqual(rosterJobLabel('notes'), 'notes');
  assert.strictEqual(rosterJobLabel('two--parts'), 'two  parts');
  assert.strictEqual(rosterJobLabel('Navigator'), 'Navigator');
});

test('rosterJobLabel returns an empty label for absent or empty keys', () => {
  assert.strictEqual(rosterJobLabel(), '');
  assert.strictEqual(rosterJobLabel(undefined), '');
  assert.strictEqual(rosterJobLabel(null), '');
  assert.strictEqual(rosterJobLabel(''), '');
});
