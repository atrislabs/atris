const test = require('node:test');
const assert = require('node:assert/strict');
const { earnedUsd } = require('../lib/receipt-block');

test('a receipt with no result has no earnings', () => {
  assert.strictEqual(earnedUsd({ objective: 'Check the saved receipt', result: null }), 0);
});
