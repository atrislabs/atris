const test = require('node:test');
const assert = require('node:assert/strict');
const { classify } = require('../lib/deck-compose');

test('a section with only a heading preserves its statement text', () => {
  const heading = 'Own your intelligence stack';
  const result = classify(heading, []);
  assert.strictEqual(result.text, heading);
});
