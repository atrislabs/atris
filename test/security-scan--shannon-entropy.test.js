'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { shannonEntropy } = require('../lib/security-scan');

test('uniform character distributions have the expected entropy in bits', () => {
  assert.strictEqual(shannonEntropy('ab'), 1);
  assert.strictEqual(shannonEntropy('abcd'), 2);
  assert.strictEqual(shannonEntropy('aabbccdd'), 2);
});

test('unequal character frequencies determine entropy regardless of order', () => {
  const expected = 0.8112781244591328; // Three quarters a, one quarter b.
  assert.ok(Math.abs(shannonEntropy('aaab') - expected) < 1e-12);
  assert.ok(Math.abs(shannonEntropy('abaa') - expected) < 1e-12);
});

test('a single distinct character has zero entropy', () => {
  assert.strictEqual(shannonEntropy('a'), 0);
  assert.strictEqual(shannonEntropy('aaaaaaaa'), 0);
  assert.strictEqual(shannonEntropy('    '), 0);
});

test('empty and missing inputs have zero entropy', () => {
  assert.strictEqual(shannonEntropy(''), 0);
  assert.strictEqual(shannonEntropy(), 0);
  assert.strictEqual(shannonEntropy(undefined), 0);
  assert.strictEqual(shannonEntropy(null), 0);
});
