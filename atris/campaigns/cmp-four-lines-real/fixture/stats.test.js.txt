const test = require('node:test');
const assert = require('node:assert');
const { mean } = require('../src/mean');
const { median } = require('../src/median');

test('mean of a few numbers', () => {
  assert.strictEqual(mean([1, 2, 3]), 2);
});

test('median of an odd-length sorted list', () => {
  assert.strictEqual(median([1, 2, 3]), 2);
});
