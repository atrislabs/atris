const test = require('node:test');
const assert = require('node:assert/strict');
const { pickLane } = require('../lib/ax-auto-lane');

test('a short lookup skips an override requiring longer input', () => {
  const result = pickLane('what is gravity?', {
    overrides: [{
      id: 'long-only',
      test: { minChars: 100 },
      lane: 'max',
      reason: 'long input.',
    }],
  });

  assert.strictEqual(result.lane, 'fast');
});
