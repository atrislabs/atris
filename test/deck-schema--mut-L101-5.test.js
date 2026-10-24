const test = require('node:test');
const assert = require('node:assert/strict');
const { validateSpec } = require('../lib/deck-schema');

test('a bullets slide accepts exactly one item without findings', () => {
  assert.deepStrictEqual(
    validateSpec({ slides: [{ type: 'bullets', items: ['One item'] }] }),
    []
  );
});
