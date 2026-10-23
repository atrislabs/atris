const test = require('node:test');
const assert = require('node:assert/strict');
const { pickLane } = require('../lib/ax-auto-lane');

test('a null override does not prevent a later matching lane choice', () => {
  const result = pickLane('What is the capital of France?', {
    overrides: [
      null,
      {
        id: 'capital-lookup',
        test: { startsWith: 'what is', includesAll: ['capital'], maxChars: 80 },
        lane: 'max',
        reason: 'use the saved lookup preference.',
      },
    ],
  });

  assert.strictEqual(result.lane, 'max');
});
